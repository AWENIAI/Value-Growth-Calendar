#!/usr/bin/env node
/**
 * 策略A · WorkBuddy 部署版（15日 / ±3pp 双阈值滞回相对动量轮动 · 真实阶梯成本）
 * ----------------------------------------------------------------------------
 * 部署目录：/opt/Value-Growth-Calendar-worbuddy
 * 每天收盘后（cron：0 18 * * 1-5）执行：
 *   1. 从国证官网服务端抓取 980080/980081 最新收盘（Node fetch，不受浏览器 CORS 限制）
 *   2. 追加到 worbuddy/forward/close-input.csv（本地持久化，冷启动用基础历史 xls 预热）
 *   3. 复用与本地回测 100% 一致的 runRotationBacktest 引擎算出当日信号
 *   4. 写出 docs/worbuddy/calendar.ics（苹果日历订阅）+ signal.json（网页读取）+ index.html（网页版）
 *
 * 用法：
 *   node worbuddy/sync.mjs            # 抓最新 + 算信号 + 写 docs/worbuddy/
 *   node worbuddy/sync.mjs --local   # 不联网，仅用已有数据生成一次（初次部署/离线测试用）
 *
 * 之后由 /opt/calendar-git-sync.sh 把 docs/worbuddy/ 与 worbuddy/ 提交并推送到 GitHub，
 * GitHub Pages 以 HTTPS 发布，苹果日历订阅 docs/worbuddy/calendar.ics 即更新。
 */

import { parseMarketFile } from './src/market-file-parser.mjs';
import { runRotationBacktest } from './src/backtest-engine.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 仓库根目录（worbuddy/ 的父目录）
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'worbuddy', '价值成长 100 数据');
const FWD = path.join(ROOT, 'worbuddy', 'forward');
const DIST = path.join(ROOT, 'docs', 'worbuddy');
fs.mkdirSync(FWD, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

const CODE_G = '980080';
const CODE_V = '980081';
const FILE_G = '980080_perf_20121231-20260902.xls';
const FILE_V = '980081_perf_20121231-20260902.xls';

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
function loadForward() {
  if (!fs.existsSync(fwdPath)) return [];
  const txt = fs.readFileSync(fwdPath, 'utf8').trim();
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
function buildRows(forward) {
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
function runAll(forward) {
  const rowsByCode = buildRows(forward);
  const lastDate = rowsByCode[CODE_G][rowsByCode[CODE_G].length - 1].date;
  return runRotationBacktest({
    rowsByCode,
    parameters: PARAMS,
    backtest_start: BACKTEST_START,
    backtest_end: lastDate,
    initial_capital: INITIAL_CAPITAL,
    initial_position: SEED,
  });
}

async function fetchNewRows() {
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
function buildICS(rep) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const evtDate = nextTradingDay(rep.date); // 事件落在下一交易日 09:00，确保苹果刷新时仍在未来
  const dtStart = `${evtDate.replace(/-/g, '')}T090000`;
  const dtEnd = `${evtDate.replace(/-/g, '')}T090500`;
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
    `策略：15日相对动量轮动 · 价格指数980080/980081 · ±3pp 滞回 · 真实阶梯成本`,
  ];
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WorkBuddy//StrategyA//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:策略A·WorkBuddy轮动(15d/±3pp)',
    'X-WR-TIMEZONE:Asia/Shanghai',
    'X-PUBLISHED-TTL:PT15M',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'LAST-MODIFIED:' + stamp,
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
    '',
  ].join('\r\n');
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
    <div class="sub">15日相对动量 · 价格指数 980080/980081 · ±3pp 滞回 · 真实阶梯成本</div>
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
    <div class="foot">生成于 ${new Date(rep.generated_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · 数据来源：国证指数官网</div>
  </div>
</body>
</html>`;
}

async function main() {
  const localOnly = process.argv.includes('--local');
  if (!localOnly) {
    console.log('① 抓取国证官网最新收盘…');
    const added = await fetchNewRows();
    if (added.length === 0) console.log('   无晚于基础历史的新交易日，沿用已有数据。');
  } else {
    console.log('① 离线模式：仅用已有数据生成。');
  }
  const forward = loadForward();
  const res = runAll(forward);
  const rep = buildReport(res);
  fs.writeFileSync(path.join(DIST, 'signal.json'), JSON.stringify(rep, null, 2) + '\n');
  fs.writeFileSync(path.join(DIST, 'calendar.ics'), buildICS(rep));
  fs.writeFileSync(path.join(DIST, 'index.html'), buildHTML(rep));
  console.log('\n② 当日信号：');
  console.log(`   数据日期    : ${rep.date}`);
  console.log(`   当前持仓    : ${rep.position_name} ${rep.changed_today ? '（今日已切换）' : ''}`);
  console.log(`   D 值        : ${rep.d_pp}pp（阈值 +${rep.upper}/ ${rep.lower}）`);
  console.log(`   明日操作    : ${rep.next_action.startsWith('SWITCH') ? '🔄 切到 ' + rep.switch_to + '（' + rep.execution_date + '）' : '✅ 持有不动'}`);
  console.log(`   换仓成本    : ${rep.switch_fee_note}`);
  console.log('\n③ 已写出 docs/worbuddy/{signal.json, calendar.ics, index.html}');
  console.log('   下一步：用 /opt/calendar-git-sync.sh 提交并推送到 GitHub，Pages 即更新。');
}

main().catch((e) => {
  console.error('错误：' + e.message);
  process.exit(1);
});
