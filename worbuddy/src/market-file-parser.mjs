import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * Node 原生行情文件解析器。
 *
 * 设计目标：让工具零外部依赖运行（不依赖 pandas / openpyxl / Python 解释器）。
 * 归一化输出必须与 scripts/parse-market-file.py 逐字节一致，
 * 因此 normalized_data_sha256 可直接跨解析器比对，历史台账不会失效。
 */

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number(dec)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (whole, name) => XML_ENTITIES[name] ?? whole);
}

function safeCodePoint(code) {
  return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/* ------------------------------------------------------------------ ZIP */

function readZipCentralDirectory(buffer) {
  // EOCD: 签名 0x06054b50，位于文件尾部，最多回退 64KB + 22 字节寻找。
  const scanStart = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= scanStart; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  // ZIP64 的 EOCD 签名不同；这里只需一个可读的错误提示。
  if (eocd < 0) throw new Error('不是有效的 xlsx/ZIP 文件：未找到中央目录。');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    entries.set(name, { method, compressedSize, localHeaderOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(buffer, entry) {
  const localOffset = entry.localHeaderOffset;
  if (localOffset + 30 > buffer.length) throw new Error('ZIP 局部头越界，文件可能已损坏。');
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP 局部头签名不匹配。');
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`不支持的 ZIP 压缩方式：${entry.method}。`);
}

/* ----------------------------------------------------------------- XLSX */

function columnReferenceToIndex(reference) {
  const letters = /^([A-Z]+)/.exec(String(reference || ''))?.[1];
  if (!letters) return -1;
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

function parseSharedStrings(xml) {
  const strings = [];
  const sharedItemPattern = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  for (const item of xml.matchAll(sharedItemPattern)) {
    let text = '';
    for (const run of item[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += decodeXml(run[1]);
    strings.push(text);
  }
  return strings;
}

function parseWorksheet(xml, sharedStrings) {
  const rows = [];
  const rowPattern = /<row\b([^>]*)(?:\/>|>([\s\S]*?)<\/row>)/g;

  for (const rowMatch of xml.matchAll(rowPattern)) {
    const content = rowMatch[2] || '';
    const cells = [];
    let sequentialIndex = 0;

    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    for (const cellMatch of content.matchAll(cellPattern)) {
      const attributes = cellMatch[1] || '';
      const cellContent = cellMatch[2] || '';
      const reference = /\br="([A-Z]+\d+)"/.exec(attributes)?.[1] || '';
      let columnIndex = columnReferenceToIndex(reference);
      if (columnIndex < 0) columnIndex = sequentialIndex;
      sequentialIndex = columnIndex + 1;

      const type = /\bt="([^"]+)"/.exec(attributes)?.[1] || 'n';
      let value;

      if (type === 'inlineStr') {
        let text = '';
        for (const run of cellContent.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += decodeXml(run[1]);
        value = text;
      } else {
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cellContent)?.[1];
        if (raw === undefined) {
          value = '';
        } else if (type === 's') {
          value = sharedStrings[Number(raw)] ?? '';
        } else if (type === 'str' || type === 'e') {
          value = decodeXml(raw);
        } else if (type === 'b') {
          value = raw === '1' ? 'TRUE' : 'FALSE';
        } else {
          const numeric = Number(raw);
          value = Number.isNaN(numeric) ? '' : numeric;
        }
      }

      if (value === '' || value === null || value === undefined) continue;
      cells[columnIndex] = value;
    }

    if (cells.length === 0) continue;
    for (let index = 0; index < cells.length; index++) {
      if (cells[index] === undefined) cells[index] = '';
    }
    rows.push(cells);
  }
  return rows;
}

function readXlsxGrid(filePath) {
  const buffer = fs.readFileSync(filePath);
  const entries = readZipCentralDirectory(buffer);

  const sharedStringsEntry = entries.get('xl/sharedStrings.xml');
  const sharedStrings = sharedStringsEntry
    ? parseSharedStrings(readZipEntry(buffer, sharedStringsEntry).toString('utf8'))
    : [];

  const sheetNames = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name))
    .sort((a, b) => {
      const numericA = Number(/(\d+)\.xml$/.exec(a)?.[1] ?? Infinity);
      const numericB = Number(/(\d+)\.xml$/.exec(b)?.[1] ?? Infinity);
      return numericA - numericB || a.localeCompare(b);
    });
  if (sheetNames.length === 0) throw new Error('xlsx 中未找到工作表。');

  return parseWorksheet(readZipEntry(buffer, entries.get(sheetNames[0])).toString('utf8'), sharedStrings);
}

/* ------------------------------------------------------------------ CSV */

function splitDelimitedLine(line, delimiter) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function readCsvGrid(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new Error('CSV 文件为空。');

  const firstLine = lines[0];
  const delimiter = [',', ';', '\t'].sort(
    (a, b) => splitDelimitedLine(firstLine, b).length - splitDelimitedLine(firstLine, a).length,
  )[0];

  return lines.map((line) => splitDelimitedLine(line, delimiter).map((cell) => cell.trim()));
}

/* -------------------------------------------------------- 日期与数值归一 */

const DATE_HEADER_PATTERN = /^(日期|date|tradedate|交易日期|时间)$/i;

function excelSerialToIsoDate(serial) {
  if (!Number.isFinite(serial) || serial <= 0) return '';
  const wholeDays = Math.floor(serial);
  // Excel 的 1900 日期系统含一个虚构的 1900-02-29，序列号 >= 61 时需要回退一天。
  const adjusted = wholeDays >= 61 ? wholeDays - 1 : wholeDays;
  const utc = new Date(Date.UTC(1899, 11, 31) + adjusted * 86400000);
  if (Number.isNaN(utc.getTime())) return '';
  return utc.toISOString().slice(0, 10);
}

function normalizeToIsoDate(value) {
  if (typeof value === 'number') return excelSerialToIsoDate(value);
  const text = String(value).trim();
  if (!text) return '';
  const compact = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (compact) {
    const [, year, month, day] = compact;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  const flat = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (flat) return `${flat[1]}-${flat[2]}-${flat[3]}`;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime()) && /^\d{4}/.test(text)) return parsed.toISOString().slice(0, 10);
  return '';
}

function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const text = String(value).trim().replace(/,/g, '');
  if (text === '' || text === '-' || text === '--' || /^(null|nan|none)$/i.test(text)) return NaN;
  return Number(text);
}

/**
 * 复刻 Python 的 float repr，保证归一化 CSV 与 pandas 输出逐字节一致。
 * Python 在 |x| < 1e-4 或 |x| >= 1e16 时切换为指数形式，且指数至少两位。
 */
export function pythonFloatRepr(value) {
  if (Object.is(value, -0)) return '-0.0';
  if (!Number.isFinite(value)) return String(value);
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e16)) {
    const [mantissa, exponent] = value.toExponential().split('e');
    const sign = exponent.startsWith('-') ? '-' : '+';
    const digits = exponent.replace(/^[+-]/, '');
    return `${mantissa}e${sign}${digits.padStart(2, '0')}`;
  }
  const text = String(value);
  return /[.e]/.test(text) ? text : `${text}.0`;
}

/* ------------------------------------------------------------- 主解析入口 */

function pickColumn(headers, preferredNames, fallbackPredicate) {
  const cleaned = headers.map((header) => String(header ?? '').trim());
  for (const name of preferredNames) {
    const index = cleaned.findIndex((header) => header === name);
    if (index >= 0) return index;
  }
  if (fallbackPredicate) {
    const index = cleaned.findIndex(fallbackPredicate);
    if (index >= 0) return index;
  }
  return -1;
}

export function parseMarketFile(filePath, options = {}) {
  const { assetCode = '', dateColumn = 'Date', priceColumn = 'Close' } = options;

  if (!fs.existsSync(filePath)) throw new Error(`行情文件不存在：${filePath}`);

  const raw = fs.readFileSync(filePath);
  const rawFileSha256 = crypto.createHash('sha256').update(raw).digest('hex');
  const extension = filePath.toLowerCase().split('.').pop();

  let grid;
  if (extension === 'csv' || extension === 'txt') {
    grid = readCsvGrid(filePath);
  } else if (extension === 'xlsx' || extension === 'xls') {
    if (raw.subarray(0, 2).toString('binary') !== 'PK') {
      throw new Error('这是老式二进制 .xls（非 OOXML）。请在 Excel 中另存为 .xlsx 或 .csv 后重试。');
    }
    grid = readXlsxGrid(filePath);
  } else {
    throw new Error(`不支持的文件类型：.${extension}`);
  }

  if (grid.length === 0) throw new Error('行情文件为空。');

  const headerRowIndex = grid.findIndex((row) => row.some((cell) => String(cell).trim() !== ''));
  if (headerRowIndex < 0) throw new Error('未找到表头行。');
  const headers = grid[headerRowIndex];

  let dateIndex = pickColumn(headers, [dateColumn, '日期', 'Date', '交易日期', '时间']);
  if (dateIndex < 0) dateIndex = pickColumn(headers, [], (header) => DATE_HEADER_PATTERN.test(header));

  let priceIndex = pickColumn(headers, [priceColumn, '收盘价', 'Close', assetCode]);
  if (priceIndex < 0) priceIndex = pickColumn(headers, [], (header) => /收盘|close/i.test(header) || header === assetCode);

  if (dateIndex < 0) {
    throw new Error(`缺少日期列：${dateColumn}。可用列：${headers.map((item) => String(item).trim()).join('，')}`);
  }
  if (priceIndex < 0) {
    throw new Error(`缺少价格列：${priceColumn} 或 ${assetCode}。可用列：${headers.map((item) => String(item).trim()).join('，')}`);
  }

  const seen = new Set();
  const rows = [];
  for (let index = headerRowIndex + 1; index < grid.length; index++) {
    const row = grid[index];
    const date = normalizeToIsoDate(row[dateIndex]);
    if (!date) continue; // 脚注行 / 空行：与 pandas dropna 行为一致
    const price = toFiniteNumber(row[priceIndex]);
    if (!Number.isFinite(price)) continue;

    if (seen.has(date)) throw new Error(`日期重复：${date}`);
    seen.add(date);
    rows.push({ date, price });
  }

  if (rows.length === 0) throw new Error('未解析出任何有效行情行。');
  rows.sort((a, b) => a.date.localeCompare(b.date));

  const negative = rows.find((row) => row.price <= 0);
  if (negative) throw new Error(`价格列存在小于等于 0 的数据：${negative.date} = ${negative.price}`);

  const normalized = 'date,price\n' + rows.map((row) => `${row.date},${pythonFloatRepr(row.price)}`).join('\n') + '\n';

  return {
    raw_file_sha256: rawFileSha256,
    normalized_data_sha256: crypto.createHash('sha256').update(normalized, 'utf8').digest('hex'),
    date_column: String(headers[dateIndex]).trim(),
    price_column: String(headers[priceIndex]).trim(),
    first_date: rows[0].date,
    last_date: rows[rows.length - 1].date,
    row_count: rows.length,
    rows,
  };
}
