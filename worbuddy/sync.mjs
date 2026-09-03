#!/usr/bin/env node
/**
 * 策略A · WorkBuddy 部署版（15日 / ±3pp 双阈值滞回相对动量轮动 · 真实阶梯成本）
 * ----------------------------------------------------------------------------
 * 部署目录：/opt/Value-Growth-Calendar-worbuddy
 * 每天收盘后执行（cron，建议 21:00 周一至五，待基金净值发布后）：
 *   默认模式：从国证官网服务端抓取 980080/980081 最新收盘（Node fetch）。
 *   NAV 模式（NAV_MODE=1）：调用 fetch_nav.py，从东财基金接口抓取实盘持有基金
 *     027859(成长100)/026936(价值100) 净值，替代国证官网（CVM 不被反爬封、无需 Mac）。
 *   两种模式共用同一套引擎/状态机/成本/.ics 生成逻辑，仅数据源不同。
 *   1. 抓取最新收盘（或净值）→ 追加到 worbuddy/forward/close-input[-nav].csv
 *   2. 复用与本地回测 100% 一致的 runRotationBacktest 引擎算出当日信号
 *   3. 写出 docs/feed/calendar.ics（苹果日历订阅）+ signal.json（网页读取）+ index.html（网页版）
 *
 * 用法：
 *   NAV_MODE=1 node worbuddy/sync.mjs            # NAV 模式：抓净值 + 算信号 + 写 docs/feed/
 *   node worbuddy/sync.mjs                       # 默认指数模式
 *   node worbuddy/sync.mjs --local              # 不联网，仅用已有数据生成一次（离线测试用）
 *
 * 之后由 git 提交并推送到 GitHub，GitHub Pages 以 HTTPS 发布，苹果日历订阅
 * docs/feed/calendar.ics 即更新。
 */

import { parseMarketFile } from './src/market-file-parser.mjs';
import { runRotationBacktest } from './src/backtest-engine.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 仓库根目录（worbuddy/ 的父目录）
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'worbuddy', '价值成长 100 数据');
const FWD = path.join(ROOT, 'worbuddy', 'forward');
const DIST = path.join(ROOT, 'docs', 'feed'); // Pages 源为 /docs（标准映射 docs/X → 站点 /X）
fs.mkdirSync(FWD, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

const CODE_G = '980080';
const CODE_V = '980081';
const FILE_G = '980080_perf_20121231-20260902.xls';
const FILE_V = '980081_perf_20121231-20260902.xls';

// NAV 模式：实盘持有基金（东财/akshare 接口，CVM 可直连，不被反爬封）
const NAV_MODE = process.env.NAV_MODE === '1';
const NAV_CODE_G = '027859'; // 易方达国证成长100ETF联接C（成长腿）
const NAV_CODE_V = '026936'; // 大成国证价值100指数C（价值腿）
const FWD_NAV = path.join(FWD, 'close-input-nav.csv');

// 真实成本下优化所得（walk-forward 4/4 稳健、短期换仓最少、回撤最优）
const PARAMS = {
  asset_1_code: CODE_G,
  asset_1_name: '成长100',
  asset_2_code: CODE_V,
  asset_2_name: '价值100',
  lookback_days: 15,
  upper_threshold_pp: 3,
  lower_threshold_pp: -3,
  cost_model: 'holding_period',
  holding_threshold_days: 7,
  short_term_fee_pct: 1.5,
  long_term_fee_pct: 0,
  index_type: '价格',
};
const SEED = 'VALUE';
const INITIAL_CAPITAL = 100000;
const BACKTEST_START = '2013-01-02';

const HOLDING_DAYS = 7;
const SHORT_FEE = 1.5;
function feeForHoldingDays(days) {
  return days < HOLDING_DAYS ? SHORT_FEE : 0;
}
function calDays(a, b) {
  const ms = new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime();
  return ms / 86400000;
}
function nextDayStr(date) {
  const t = new Date(`${date}T00:00:00Z`).getTime() + 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
function shiftDays(dateStr, n) {
  const t = new Date(`${dateStr}T00:00:00Z`).getTime() + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
// 下一交易日（跳过周六日；节假日未建模，沿用既有简化口径）
function nextTradingDay(dateStr) {
  let d = new Date(`${dateStr}T00:00:00Z`).getTime() + 86400000;
  let wd = new Date(d).getUTCDay();
  while (wd === 0 || wd === 6) {
    d += 86400000;
    wd = new Date(d).getUTCDay();
  }
  return new Date(d).toISOString().slice(0, 10);
}
function posName(p) {
  return p === 'GROWTH' ? '成长100' : '价值100';
}

const fwdPath = path.join(FWD, 'close-input.csv');

function loadBase(code, file) {
  return parseMarketFile(path.join(DATA, file), { assetCode: code }).rows;
}
function loadForward(file = fwdPath) {
  if (!fs.existsSync(file)) return [];
  const txt = fs.readFileSync(file, 'utf8').trim();
  if (!txt) return [];
  const out = [];
  for (const line of txt.split(/\r?\n/)) {
    const [date, g, v] = line.split(',').map((s) => s.trim());
    if (!date || date === 'date') continue;
    out.push({ date, g: Number(g), v: Number(v) });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
function appendForward(date, g, v) {
  let lines = [];
  if (fs.existsSync(fwdPath)) lines = fs.readFileSync(fwdPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  if (lines[0] !== 'date,g,v') lines = ['date,g,v', ...lines.filter((l) => l !== 'date,g,v')];
  if (lines.some((l) => l.startsWith(date + ','))) throw new Error(`日期 ${date} 已存在，请勿重复录入。`);
  lines.push(`${date},${g},${v}`);
  fs.writeFileSync(fwdPath, lines.join('\n') + '\n');
}
function buildRows(forward, nav = false) {
  if (nav) {
    // NAV 模式：直接用净值序列（已保证 g/v 同日期对齐），不混入指数基础历史
    const mapG = new Map(forward.map((c) => [c.date, c.g]));
    const mapV = new Map(forward.map((c) => [c.date, c.v]));
    const dates = [...new Set([...mapG.keys(), ...mapV.keys()])].sort();
    return {
      [CODE_G]: dates.map((d) => ({ date: d, price: mapG.get(d) })).filter((r) => r.price != null),
      [CODE_V]: dates.map((d) => ({ date: d, price: mapV.get(d) })).filter((r) => r.price != null),
    };
  }
  const baseG = loadBase(CODE_G, FILE_G);
  const baseV = loadBase(CODE_V, FILE_V);
  const lastBase = baseG[baseG.length - 1].date;
  const merge = (base, key) => {
    const map = new Map(base.map((r) => [r.date, r.price]));
    for (const c of forward) {
      if (c.date <= lastBase) continue;
      map.set(c.date, c[key]);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, price]) => ({ date, price }));
  };
  return { [CODE_G]: merge(baseG, 'g'), [CODE_V]: merge(baseV, 'v') };
}
function runAll(forward, nav = false) {
  const rowsByCode = buildRows(forward, nav);
  const lastDate = rowsByCode[CODE_G][rowsByCode[CODE_G].length - 1].date;
  // NAV 模式已用指数长历史对齐缩放，序列覆盖完整回测区间，直接用 BACKTEST_START
  const bStart = BACKTEST_START;
  return runRotationBacktest({
    rowsByCode,
    parameters: PARAMS,
    backtest_start: bStart,
    backtest_end: lastDate,
    initial_capital: INITIAL_CAPITAL,
    initial_position: SEED,
  });
}

async function fetchNewRows() {
  if (NAV_MODE) {
    const py = process.env.PYTHON_BIN || '/home/ubuntu/venv_ib/bin/python';
    const script = path.join(__dirname, 'fetch_nav.py');
    console.log(`  ① NAV 模式：调用 fetch_nav.py 抓取 ${NAV_CODE_G}/${NAV_CODE_V} 净值…`);
    execSync(`"${py}" "${script}"`, { stdio: 'inherit' });
    return [];
  }
  const baseG = loadBase(CODE_G, FILE_G);
  const lastBase = baseG[baseG.length - 1].date;
  const today = new Date().toISOString().slice(0, 10);
  const STR = 'http://hq.cnindex.com.cn/market/market/getIndexDailyDataWithDataFormat';
  const fetchCode = async (code) => {
    const u = new URL(STR);
    u.searchParams.set('indexCode', code);
    u.searchParams.set('startDate', lastBase);
    u.searchParams.set('endDate', today);
    u.searchParams.set('frequency', 'day');
    const r = await fetch(u.toString(), { signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    const rows = j?.data?.data || [];
    const map = {};
    for (const row of rows) map[row[0]] = Number(row[5]);
    return map;
  };
  const gMap = await fetchCode(CODE_G);
  const vMap = await fetchCode(CODE_V);
  const dates = [...new Set([...Object.keys(gMap), ...Object.keys(vMap)])].filter((d) => d > lastBase).sort();
  const added = [];
  for (const d of dates) {
    if (gMap[d] == null || vMap[d] == null) {
      console.log(`  跳过 ${d}：成长或价值缺失`);
      continue;
    }
    try {
      appendForward(d, gMap[d], vMap[d]);
      added.push(d);
      console.log(`  录入 ${d}：成长 ${gMap[d]} / 价值 ${vMap[d]}`);
    } catch (e) {
      console.log(`  ${d} 已存在，跳过。`);
    }
  }
  return added;
}

function buildReport(res) {
  const curve = res.curve;
  const today = curve[curve.length - 1];
  const prev = curve[curve.length - 2];
  const changedToday = prev ? today.position !== prev.position : false;
  const pending = res.trades.find((t) => t.signal_date === today.date);
  const entryDate = (() => {
    const past = res.trades.filter((t) => t.signal_date < today.date);
    return past.length ? past[past.length - 1].signal_date : res.window.entry_date;
  })();
  const heldDays = calDays(entryDate, today.date);
  const pnlPct = prev ? (today.equity / prev.equity - 1) * 100 : 0;

  let nextAction = 'HOLD';
  let switchTo = null;
  let executionDate = null;
  let switchFeePct = feeForHoldingDays(heldDays);
  let reason;
  if (pending) {
    nextAction = 'SWITCH_TO_' + pending.to;
    switchTo = pending.to;
    executionDate = pending.execution_date || nextDayStr(today.date);
    switchFeePct = pending.cost_pct;
    reason = `D=${today.momentum_pp.toFixed(2)}pp 已突破阈值（${PARAMS.lower_threshold_pp}/${PARAMS.upper_threshold_pp}pp），下一交易日（${executionDate}）切换至${posName(pending.to)}。`;
  } else {
    reason = `D=${today.momentum_pp.toFixed(2)}pp，未突破阈值（${PARAMS.lower_threshold_pp}/${PARAMS.upper_threshold_pp}pp），维持${posName(today.position)}不动。`;
  }

  return {
    date: today.date,
    position: today.position,
    position_name: posName(today.position),
    changed_today: changedToday,
    d_pp: Number(today.momentum_pp.toFixed(2)),
    upper: PARAMS.upper_threshold_pp,
    lower: PARAMS.lower_threshold_pp,
    next_action: nextAction,
    switch_to: switchTo ? posName(switchTo) : null,
    execution_date: executionDate,
    switch_fee_pct: Number(switchFeePct.toFixed(2)),
    switch_fee_note: switchFeePct > 0 ? `⚠️ ${switchFeePct}% 短期赎回费（持有 ${heldDays.toFixed(1)} 天 <7 天）` : `✅ 免赎回费（持有 ${heldDays.toFixed(1)} 天 ≥7 天）`,
    pnl_pct: Number(pnlPct.toFixed(2)),
    equity: Number(today.equity.toFixed(2)),
    reason,
    summary: {
      total_return_pct: Number(res.summary.total_return_pct.toFixed(2)),
      cagr_pct: Number(res.summary.cagr_pct.toFixed(2)),
      max_drawdown_pct: Number(res.summary.max_drawdown_pct.toFixed(2)),
      sharpe_ratio: Number(res.summary.sharpe_ratio.toFixed(2)),
      trade_count: res.summary.trade_count,
      final_position: posName(res.summary.final_position),
    },
    generated_at: new Date().toISOString(),
  };
}

function icsEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}
// RFC 5545 硬性要求：物理行 ≤75 octets；续行以空格(0x20)开头、≤74 octets；
// 且绝不可在 UTF-8 多字节字符中间切断（否则中文会乱码 + 解析失败）。
// 苹果日历(CalendarKit)严格遵循此规则，未折行的超长行会被直接拒收（"验证失败"）。
function foldLine(line) {
  const enc = Buffer.from(line, 'utf8');
  if (enc.length <= 75) return line;
  // 贪心折行：逐字符累计 UTF-8 字节，加入下一个完整字符会超限额（首行75/续行74含前导空格）即折行。
  // 绝不切断多字节字符，续行以单个空格(0x20)开头。数学上保证任何物理行 ≤75 octets。
  const lines = [];
  let cur = Buffer.alloc(0);
  let first = true;
  let i = 0;
  while (i < enc.length) {
    let j = i + 1;
    while (j < enc.length && (enc[j] & 0xc0) === 0x80) j++; // 跳过 UTF-8 续字节，锁定完整字符
    const chLen = j - i;
    const limit = first ? 75 : 74; // 续行首字节是空格，留 1 字节
    if (cur.length + (first ? 0 : 1) + chLen > limit) {
      lines.push((first ? '' : ' ') + cur.toString('utf8'));
      first = false;
      cur = Buffer.alloc(0);
    }
    cur = Buffer.concat([cur, enc.slice(i, j)]);
    i = j;
  }
  if (cur.length > 0) lines.push((first ? '' : ' ') + cur.toString('utf8'));
  return lines.join('\r\n');
}
function buildICS(rep) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const evtDate = rep.date; // 事件落在数据日期当天（用户要求：日历事件对应数据日期，而非下一交易日）
  const dtStart = `${evtDate.replace(/-/g, '')}T180000`; // 当天收盘后 18:00
  const dtEnd = `${evtDate.replace(/-/g, '')}T183000`;
  const summary = rep.next_action.startsWith('SWITCH')
    ? `策略A·持${rep.position_name}｜${evtDate} 切${rep.switch_to}`
    : `策略A·持${rep.position_name}`;
  const descLines = [
    `数据日期：${rep.date}`,
    `当前持仓：${rep.position_name}`,
    `D值：${rep.d_pp}pp（阈值 +${rep.upper}/ ${rep.lower}）`,
    `下一交易日操作：${rep.next_action.startsWith('SWITCH') ? '切换至' + rep.switch_to + '（' + rep.execution_date + ' 生效）' : '持有不动'}`,
    `换仓成本：${rep.switch_fee_note}`,
    `当日盈亏：${rep.pnl_pct >= 0 ? '+' : ''}${rep.pnl_pct}%`,
    `累计收益：${rep.summary.total_return_pct}%（CAGR ${rep.summary.cagr_pct}%）`,
    `原因：${rep.reason}`,
    `策略：15日相对动量轮动 · 净值027859/026936(对应指数980080/980081) · ±3pp 滞回 · 真实阶梯成本`,
  ];
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WorkBuddy//StrategyA//CN',
    'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:策略A·WorkBuddy轮动(15d/±3pp)',
    'X-WR-TIMEZONE:Asia/Shanghai',
    'X-PUBLISHED-TTL:PT15M',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'LAST-MODIFIED:' + stamp,
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Shanghai',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'TZNAME:CST',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:strategy-a-worbuddy@value-growth-calendar',
    'DTSTAMP:' + stamp,
    `DTSTART;TZID=Asia/Shanghai:${dtStart}`,
    `DTEND;TZID=Asia/Shanghai:${dtEnd}`,
    'LOCATION:中国',
    'TRANSP:TRANSPARENT',
    'CATEGORIES:策略A',
    `SUMMARY:${icsEscape(summary)}`,
    `DESCRIPTION:${icsEscape(descLines.join('\n'))}`,
    'BEGIN:VALARM',
    'TRIGGER;RELATED=START:-PT30M',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape(summary)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  // 逐行做 RFC 5545 折行（含中文按 UTF-8 字节数计算），续行以空格开头
  const body = lines.map((l) => foldLine(l)).join('\r\n');
  return body + '\r\n';
}

function buildHTML(rep) {
  const badge = rep.next_action.startsWith('SWITCH')
    ? `<span class="badge switch">🔄 下一交易日切${rep.switch_to}</span>`
    : `<span class="badge hold">✅ 持有${rep.position_name}</span>`;
  const dClass = rep.d_pp > 0 ? 'pos' : 'neg';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>策略A · 15d/±3pp 轮动信号</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; background:#f5f7fa; color:#1a1a1a; padding:24px; }
  .card { max-width:680px; margin:0 auto; background:#fff; border-radius:16px; padding:28px; box-shadow:0 4px 24px rgba(0,0,0,.06); }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:#888; font-size:13px; margin-bottom:20px; }
  .big { font-size:40px; font-weight:700; margin:8px 0; }
  .badge { display:inline-block; padding:6px 14px; border-radius:999px; font-size:15px; font-weight:600; }
  .badge.hold { background:#e8f5e9; color:#1b7735; }
  .badge.switch { background:#fff3e0; color:#b35900; }
  .row { display:flex; justify-content:space-between; padding:12px 0; border-bottom:1px solid #f0f0f0; font-size:15px; }
  .row .k { color:#666; }
  .row .v { font-weight:600; text-align:right; max-width:60%; }
  .pos { color:#c0392b; } .neg { color:#1b7735; }
  .reason { margin-top:18px; padding:14px; background:#f8f9fb; border-radius:10px; font-size:14px; line-height:1.6; }
  .foot { margin-top:18px; font-size:12px; color:#aaa; text-align:center; }
  button { margin-top:16px; width:100%; padding:12px; border:0; border-radius:10px; background:#2f6fed; color:#fff; font-size:15px; cursor:pointer; }
  button:active { background:#265bc4; }
</style>
</head>
<body>
  <div class="card">
    <h1>策略A · 成长100 / 价值100 轮动</h1>
    <div class="sub">15日相对动量 · 净值 027859/026936（对应指数 980080/980081）· ±3pp 滞回 · 真实阶梯成本</div>
    <div class="big">${rep.position_name}</div>
    ${badge}
    <div style="margin-top:20px">
      <div class="row"><span class="k">数据日期</span><span class="v">${rep.date}</span></div>
      <div class="row"><span class="k">D 值（相对动量）</span><span class="v ${dClass}">${rep.d_pp > 0 ? '+' : ''}${rep.d_pp}pp</span></div>
      <div class="row"><span class="k">阈值区间</span><span class="v">+${rep.upper} / ${rep.lower} pp</span></div>
      <div class="row"><span class="k">下一交易日操作</span><span class="v">${rep.next_action.startsWith('SWITCH') ? '切到 ' + rep.switch_to + '（' + rep.execution_date + '）' : '持有不动'}</span></div>
      <div class="row"><span class="k">换仓成本</span><span class="v">${rep.switch_fee_note}</span></div>
      <div class="row"><span class="k">当日盈亏</span><span class="v ${rep.pnl_pct >= 0 ? 'pos' : 'neg'}">${rep.pnl_pct >= 0 ? '+' : ''}${rep.pnl_pct}%</span></div>
      <div class="row"><span class="k">累计收益 / CAGR</span><span class="v">${rep.summary.total_return_pct}% / ${rep.summary.cagr_pct}%</span></div>
      <div class="row"><span class="k">最大回撤 / 夏普</span><span class="v">${rep.summary.max_drawdown_pct}% / ${rep.summary.sharpe_ratio}</span></div>
      <div class="row"><span class="k">历史换仓次数</span><span class="v">${rep.summary.trade_count}</span></div>
    </div>
    <div class="reason">${rep.reason}</div>
    <button onclick="location.reload()">🔄 刷新信号</button>
    <div class="foot">生成于 ${new Date(rep.generated_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · 数据来源：${NAV_MODE ? '基金净值(东财/akshare) 027859/026936' : '国证指数官网'}</div>
  </div>
</body>
</html>`;
}

async function main() {
  const localOnly = process.argv.includes('--local');
  if (!localOnly) {
    if (NAV_MODE) {
      console.log('① NAV 模式：抓取 027859/026936 净值…');
      await fetchNewRows();
    } else {
      console.log('① 抓取国证官网最新收盘…');
      const added = await fetchNewRows();
      if (added.length === 0) console.log('   无晚于基础历史的新交易日，沿用已有数据。');
    }
  } else {
    console.log('① 离线模式：仅用已有数据生成。');
  }
  const forward = loadForward(NAV_MODE ? FWD_NAV : fwdPath);
  const res = runAll(forward, NAV_MODE);
  const rep = buildReport(res);

  // NAV 模式：用持久化真实持仓状态计算换仓费，避免短净值窗口重建持仓期导致的费率误报
  if (NAV_MODE) {
    const statePath = path.join(FWD, 'nav-state.json');
    let state = null;
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
    if (!state) {
      // 首次运行：以已知真实状态播种（当前腿持有≥7天，与指数系统一致）
      state = { position: rep.position, entry_date: shiftDays(rep.date, -10) };
      fs.writeFileSync(statePath, JSON.stringify(state));
    }
    const heldDays = calDays(state.entry_date, rep.date);
    const fee = feeForHoldingDays(heldDays);
    rep.switch_fee_pct = Number(fee.toFixed(2));
    rep.switch_fee_note = fee > 0
      ? `⚠️ ${fee}% 短期赎回费（持有 ${heldDays.toFixed(1)} 天 <7 天）`
      : `✅ 免赎回费（持有 ${heldDays.toFixed(1)} 天 ≥7 天）`;
    if (rep.position !== state.position) {
      state = { position: rep.position, entry_date: rep.date };
      fs.writeFileSync(statePath, JSON.stringify(state));
    }
  }

  fs.writeFileSync(path.join(DIST, 'signal.json'), JSON.stringify(rep, null, 2) + '\n');
  fs.writeFileSync(path.join(DIST, 'calendar.ics'), buildICS(rep));
  fs.writeFileSync(path.join(DIST, 'index.html'), buildHTML(rep));
  console.log('\n② 当日信号：');
  console.log(`   数据日期    : ${rep.date}`);
  console.log(`   当前持仓    : ${rep.position_name} ${rep.changed_today ? '（今日已切换）' : ''}`);
  console.log(`   D 值        : ${rep.d_pp}pp（阈值 +${rep.upper}/ ${rep.lower}）`);
  console.log(`   明日操作    : ${rep.next_action.startsWith('SWITCH') ? '🔄 切到 ' + rep.switch_to + '（' + rep.execution_date + '）' : '✅ 持有不动'}`);
  console.log(`   换仓成本    : ${rep.switch_fee_note}`);
  console.log('\n③ 已写出 docs/feed/{signal.json, calendar.ics, index.html}');
  console.log('   下一步：git 提交并推送到 GitHub，Pages 即更新。');
}

main().catch((e) => {
  console.error('错误：' + e.message);
  process.exit(1);
});
