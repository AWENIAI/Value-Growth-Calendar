/**
 * 双阈值滞回相对动量轮动回测引擎。
 *
 * 时间轴约定（关键，必须自洽）：
 *   - 第 t 个交易日收盘后，用截至 t 的收盘价计算相对动量 D(t)。
 *   - D(t) 决定第 t+1 个交易日的持仓。
 *   - 第 t+1 日的收益 = close(t+1)/close(t) - 1，由该持仓赚取。
 *   - 换仓成本在信号日收盘（即新持仓开始计息的起点）扣除。
 *
 * 因此全过程不含未来函数：决策只用 t 日及之前的收盘价，收益从 t+1 开始计。
 */

export const TRADING_DAYS_PER_YEAR = 252;
export const CALENDAR_DAYS_PER_YEAR = 365.25;

export const STRATEGY_A_PARAMETERS = Object.freeze({
  asset_1_code: '480080',
  asset_1_name: '成长100R',
  asset_2_code: '480081',
  asset_2_name: '价值100R',
  lookback_days: 15,
  upper_threshold_pp: 3,
  lower_threshold_pp: -3,
  // 真实换仓成本（基金赎回费口径）：持有不满 holding_threshold_days 自然日收 short_term_fee_pct，
  // 满则免（long_term_fee_pct=0）。两级 C 类基金典型规则：<7 天 1.5%，≥7 天 0%。
  cost_model: 'holding_period',
  holding_threshold_days: 7,
  short_term_fee_pct: 1.5,
  long_term_fee_pct: 0,
  full_rebalance_cost_pct: 0.1, // 仅 cost_model='flat' 时使用（简化口径，非真实）
  index_type: 'TRI',
  holding_mode: '单一标的满仓轮动',
  state_machine_type: '双阈值滞回',
});

const MS_PER_DAY = 86400000;

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function buildSeries(rows) {
  const dates = [];
  const prices = [];
  const byDate = new Map();
  for (const row of rows) {
    dates.push(row.date);
    prices.push(row.price);
    byDate.set(row.date, row.price);
  }
  return { dates, prices, byDate };
}

/** 求两个标的的共同交易日，并报告被剔除的日期。 */
export function intersectTradingDays(seriesA, seriesB) {
  const datesB = new Set(seriesB.dates);
  const datesA = new Set(seriesA.dates);
  const common = seriesA.dates.filter((date) => datesB.has(date)).sort();
  const excluded = [
    ...seriesA.dates.filter((date) => !datesB.has(date)).map((date) => ({ date, missing_in: seriesB.code })),
    ...seriesB.dates.filter((date) => !datesA.has(date)).map((date) => ({ date, missing_in: seriesA.code })),
  ];
  return { common, excluded };
}

/** 把请求日期吸附到数据区间内的有效交易日，并如实报告实际生效日期。 */
export function resolveWindow(dates, requestedStart, requestedEnd) {
  const first = dates[0];
  const last = dates[dates.length - 1];
  const warnings = [];

  let start = requestedStart;
  if (!dates.includes(start)) {
    const next = dates.find((date) => date >= start);
    if (start < first) {
      start = first;
      warnings.push(`回测开始日期 ${requestedStart} 早于数据起点，已吸附为 ${first}。`);
    } else if (!next) {
      throw new Error(`回测开始日期 ${requestedStart} 晚于数据终点 ${last}。`);
    } else {
      start = next;
      warnings.push(`回测开始日期 ${requestedStart} 非交易日，已吸附到其后首个交易日 ${next}。`);
    }
  }

  let end = requestedEnd;
  if (!dates.includes(end)) {
    if (end > last) {
      end = last;
      warnings.push(`回测结束日期 ${requestedEnd} 晚于数据终点，已吸附为 ${last}。`);
    } else {
      const candidates = dates.filter((date) => date <= end);
      if (candidates.length === 0) throw new Error(`回测结束日期 ${requestedEnd} 早于数据起点 ${first}。`);
      end = candidates[candidates.length - 1];
      warnings.push(`回测结束日期 ${requestedEnd} 非交易日，已吸附到其前最近交易日 ${end}。`);
    }
  }

  if (start > end) throw new Error(`回测区间无效：开始日期 ${start} 晚于结束日期 ${end}。`);
  return { start, end, warnings };
}

export function maxDrawdown(equitySeries) {
  let peak = equitySeries[0];
  let worst = 0;
  let peakIndex = 0;
  let troughIndex = 0;
  let currentPeakIndex = 0;
  for (let index = 1; index < equitySeries.length; index++) {
    if (equitySeries[index] > peak) {
      peak = equitySeries[index];
      currentPeakIndex = index;
    }
    const drawdown = equitySeries[index] / peak - 1;
    if (drawdown < worst) {
      worst = drawdown;
      peakIndex = currentPeakIndex;
      troughIndex = index;
    }
  }
  return { max_drawdown_pct: round(worst * 100, 4), peak_index: peakIndex, trough_index: troughIndex };
}

export function performanceMetrics({ equitySeries, dates, initialCapital }) {
  const returns = [];
  for (let index = 0; index < equitySeries.length; index++) {
    const previous = index === 0 ? initialCapital : equitySeries[index - 1];
    returns.push(equitySeries[index] / previous - 1);
  }

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.length > 1
      ? returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1)
      : 0;
  const stdDev = Math.sqrt(variance);
  const dailyVol = stdDev;

  const finalEquity = equitySeries[equitySeries.length - 1];
  const totalReturn = finalEquity / initialCapital - 1;

  const startDate = new Date(`${dates[0]}T00:00:00Z`).getTime();
  const endDate = new Date(`${dates[dates.length - 1]}T00:00:00Z`).getTime();
  const years = Math.max((endDate - startDate) / (CALENDAR_DAYS_PER_YEAR * MS_PER_DAY), 1e-9);
  const cagr = years > 0 ? (finalEquity / initialCapital) ** (1 / years) - 1 : 0;

  return {
    final_equity: round(finalEquity, 2),
    total_return_pct: round(totalReturn * 100, 4),
    cagr_pct: round(cagr * 100, 4),
    annualized_volatility_pct: round(dailyVol * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100, 4),
    sharpe_ratio: stdDev === 0 ? null : round((mean / stdDev) * Math.sqrt(TRADING_DAYS_PER_YEAR), 4),
    ...maxDrawdown(equitySeries),
  };
}

/**
 * 主入口。
 *
 * @param {object}  input
 * @param {object}  input.rowsByCode        { '480080': [{date, price}], '480081': [...] }
 * @param {object}  input.parameters        策略参数（回看周期 / 阈值 / 换仓成本）
 * @param {string}  input.backtest_start
 * @param {string}  input.backtest_end
 * @param {number}  input.initial_capital
 * @param {string}  input.initial_position  'GROWTH' | 'VALUE'，warm-up 期的种子持仓
 * @param {object}  [input.expected_hashes] { '480080': {raw_file_sha256, normalized_data_sha256} }
 */
export function runRotationBacktest(input) {
  const parameters = { ...STRATEGY_A_PARAMETERS, ...(input.parameters || {}) };
  const lookback = Math.max(1, Math.floor(Number(parameters.lookback_days)));
  const upper = Number(parameters.upper_threshold_pp);
  const lower = Number(parameters.lower_threshold_pp);
  const costModel = String(parameters.cost_model || 'flat');
  const flatCostPct = Number(parameters.full_rebalance_cost_pct || 0);
  const holdingThresholdDays = Number(parameters.holding_threshold_days || 7);
  const shortTermFee = Number(parameters.short_term_fee_pct || 0);
  const longTermFee = Number(parameters.long_term_fee_pct || 0);

  if (!Number.isFinite(lookback)) throw new Error('lookback_days 必须是数字。');
  if (!Number.isFinite(upper) || !Number.isFinite(lower)) throw new Error('阈值参数必须是数字。');
  if (upper <= lower) throw new Error('进入成长阈值必须大于进入价值阈值，否则状态机会自相矛盾。');
  if (costModel === 'flat') {
    if (!Number.isFinite(flatCostPct) || flatCostPct < 0 || flatCostPct >= 100)
      throw new Error('换仓成本必须是 0~100 之间的百分数。');
  } else if (costModel === 'holding_period') {
    if (!Number.isFinite(shortTermFee) || shortTermFee < 0 || shortTermFee >= 100)
      throw new Error('短期换仓成本必须是 0~100 之间的百分数。');
    if (!Number.isFinite(longTermFee) || longTermFee < 0 || longTermFee >= 100)
      throw new Error('长期换仓成本必须是 0~100 之间的百分数。');
    if (!Number.isFinite(holdingThresholdDays) || holdingThresholdDays <= 0)
      throw new Error('holding_threshold_days 必须是正数。');
  } else {
    throw new Error(`未知的 cost_model：${costModel}（支持 flat / holding_period）。`);
  }

  const assetA = parameters.asset_1_code;
  const assetB = parameters.asset_2_code;
  const rowsA = input.rowsByCode?.[assetA];
  const rowsB = input.rowsByCode?.[assetB];
  if (!Array.isArray(rowsA) || rowsA.length === 0) throw new Error(`缺少 ${assetA} ${parameters.asset_1_name} 的行情数据。`);
  if (!Array.isArray(rowsB) || rowsB.length === 0) throw new Error(`缺少 ${assetB} ${parameters.asset_2_name} 的行情数据。`);

  const initialCapital = Number(input.initial_capital);
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) throw new Error('初始资金必须是大于 0 的数字。');

  const seedPosition = String(input.initial_position || '').toUpperCase();
  if (seedPosition !== 'GROWTH' && seedPosition !== 'VALUE') {
    throw new Error(`初始持仓只能是 GROWTH 或 VALUE（策略为满仓轮动，不支持现金）。收到：${input.initial_position}`);
  }

  const seriesA = { ...buildSeries(rowsA), code: assetA };
  const seriesB = { ...buildSeries(rowsB), code: assetB };
  const { common: dates, excluded } = intersectTradingDays(seriesA, seriesB);

  if (dates.length < lookback + 2) {
    throw new Error(`共同交易日不足：需要至少 ${lookback + 2} 个，实际 ${dates.length} 个。`);
  }

  const window = resolveWindow(dates, String(input.backtest_start), String(input.backtest_end));
  const endIndex = dates.indexOf(window.end);
  let startIndex = dates.indexOf(window.start);
  const earliestValidStart = dates[lookback];
  let startWasAdjusted = false;

  /* 预热不足：吸附到最早可用日，避免未来函数；透明上报，不静默抛错。 */
  if (startIndex < lookback) {
    if (lookback >= dates.length) {
      throw new Error(`共同交易日不足：需要至少 ${lookback + 2} 个，实际 ${dates.length} 个。`);
    }
    const priorDays = startIndex;
    startIndex = lookback;
    window.start = earliestValidStart;
    startWasAdjusted = true;
    window.adjustment_note =
      `回测开始日 ${String(input.backtest_start)} 预热不足（其前仅 ${priorDays} 个共同交易日，` +
      `而 ${lookback} 日回看需要至少 ${lookback} 个）。已自动吸附到最早可用日 ${earliestValidStart}` +
      `（预热恰好满足，无前置信号推演）。`;
    window.warnings = [...(window.warnings || []), window.adjustment_note];
  }

  /* 吸附后仍晚于结束日：区间无效，明确报错。 */
  if (startIndex > endIndex) {
    throw new Error(
      `回测区间无效：调整后的开始日 ${window.start} 晚于结束日 ${window.end}。` +
        `请提供更长历史数据，或将结束日设到 ${earliestValidStart} 之后。`,
    );
  }

  /* ---- 完整性校验：扫描之后文件若被替换，必须失败而不是静默用错数据 ----
     同时接受 camelCase 与 snake_case，避免调用方命名风格不一致导致校验被静默跳过。 */
  const expectedHashes = input.expected_hashes ?? input.expectedHashes ?? {};
  const parsedMeta = input.parsed_meta ?? input.parsedMeta ?? {};
  const integrity = [];
  for (const [code, series, rows] of [
    [assetA, seriesA, rowsA],
    [assetB, seriesB, rowsB],
  ]) {
    const expected = expectedHashes[code];
    if (!expected) continue;
    const actual = parsedMeta[code] || {};
    for (const field of ['raw_file_sha256', 'normalized_data_sha256']) {
      if (!expected[field]) continue;
      if (actual[field] !== expected[field]) {
        throw new Error(
          `${code} 数据完整性校验失败：${field} 与扫描时记录的不一致。` +
            `扫描值 ${expected[field]}，当前值 ${actual[field]}。文件在扫描后被修改过，请重新扫描。`,
        );
      }
    }
    integrity.push({ asset_code: code, verified: true, rows: rows.length });
  }

  const priceA = seriesA.byDate;
  const priceB = seriesB.byDate;

  const momentumPp = (index) =>
    ((priceA.get(dates[index]) / priceA.get(dates[index - lookback]) - 1) -
      (priceB.get(dates[index]) / priceB.get(dates[index - lookback]) - 1)) *
    100;

  const transition = (position, diff) => {
    if (position === 'VALUE' && diff > upper) return 'GROWTH';
    if (position === 'GROWTH' && diff < lower) return 'VALUE';
    return position;
  };

  /* ---- warm-up：用真实信号把状态机演进到回测起点，而不是直接采信用户的猜测 ---- */
  let position = seedPosition;
  let warmupSignals = 0;
  for (let index = lookback; index < startIndex; index++) {
    const next = transition(position, momentumPp(index));
    if (next !== position) warmupSignals++;
    position = next;
  }

  /* ---- 主循环 ---- */
  let equity = initialCapital;
  let totalCostPaid = 0;
  let shortTermCostPaid = 0;
  let longTermCostPaid = 0;
  let daysInGrowth = 0;
  const curve = [];
  const trades = [];

  // 当前持仓的进入日期（用于按自然日持有期计赎回费）。种子仓位于回测起点前一交易日进入。
  let positionEntryDate = dates[startIndex - 1];

  for (let index = startIndex; index <= endIndex; index++) {
    const previousDate = dates[index - 1];
    const currentDate = dates[index];
    const held = position;

    const grossReturn =
      held === 'GROWTH'
        ? priceA.get(currentDate) / priceA.get(previousDate)
        : priceB.get(currentDate) / priceB.get(previousDate);
    equity *= grossReturn;
    if (held === 'GROWTH') daysInGrowth++;

    const diff = momentumPp(index);
    const next = transition(held, diff);

    curve.push({
      date: currentDate,
      equity: round(equity, 2),
      position: held,
      momentum_pp: round(diff, 4),
    });

    if (next !== held) {
      // 换仓成本：按"被退出持仓"的实际持有自然日计费率。
      let feePct;
      let holdingDays = null;
      if (costModel === 'flat') {
        feePct = flatCostPct;
      } else {
        const exitDateMs = new Date(`${currentDate}T00:00:00Z`).getTime();
        const entryMs = new Date(`${positionEntryDate}T00:00:00Z`).getTime();
        holdingDays = (exitDateMs - entryMs) / MS_PER_DAY;
        feePct = holdingDays < holdingThresholdDays ? shortTermFee : longTermFee;
      }
      const beforeCost = equity;
      equity *= 1 - feePct / 100;
      const thisCost = beforeCost - equity;
      totalCostPaid += thisCost;
      if (feePct === shortTermFee && feePct !== longTermFee) shortTermCostPaid += thisCost;
      else if (feePct === longTermFee) longTermCostPaid += thisCost;
      trades.push({
        signal_date: currentDate,
        execution_date: dates[index + 1] ?? null,
        from: held,
        to: next,
        momentum_pp: round(diff, 4),
        cost_pct: round(feePct, 4),
        holding_days: holdingDays === null ? null : round(holdingDays, 2),
        cost_tier: feePct === shortTermFee && feePct !== longTermFee ? 'short' : feePct === longTermFee ? 'long' : 'flat',
      });
      position = next;
      positionEntryDate = currentDate; // 新持仓自本日收盘后进入（次日计息）
    }
  }

  if (curve.length === 0) throw new Error('回测区间内没有任何交易日。');

  const equitySeries = curve.map((point) => point.equity);
  const metrics = performanceMetrics({ equitySeries, dates: curve.map((point) => point.date), initialCapital });

  const drawdowns = (() => {
    let peak = initialCapital;
    return equitySeries.map((value) => {
      peak = Math.max(peak, value);
      return round((value / peak - 1) * 100, 4);
    });
  })();
  curve.forEach((point, index) => {
    point.drawdown_pct = drawdowns[index];
  });

  /* ---- 换仓胜率：新持仓在其持有期内是否真的跑赢了旧持仓 ---- */
  const holdingBoundaries = trades.map((trade) => trade.signal_date).concat([curve[curve.length - 1].date]);
  let winningTrades = 0;
  const entryDate = dates[startIndex - 1];
  trades.forEach((trade, index) => {
    const from = index === 0 ? entryDate : trade.signal_date;
    const to = holdingBoundaries[index + 1];
    const ratioA = priceA.get(to) / priceA.get(from);
    const ratioB = priceB.get(to) / priceB.get(from);
    const newLeg = trade.to === 'GROWTH' ? ratioA : ratioB;
    const oldLeg = trade.from === 'GROWTH' ? ratioA : ratioB;
    trade.holding_from = from;
    trade.holding_to = to;
    trade.new_position_return_pct = round((newLeg - 1) * 100, 4);
    trade.old_position_return_pct = round((oldLeg - 1) * 100, 4);
    trade.outperformance_pp = round((newLeg - oldLeg) * 100, 4);
    const won = newLeg > oldLeg;
    trade.win = won;
    if (won) winningTrades++;
  });

  /* ---- 基准：两个标的各自买入持有，同一区间、同一成本口径（买入持有无换仓成本） ---- */
  const buildBenchmark = (series, label) => {
    const equityPath = [];
    for (let index = startIndex; index <= endIndex; index++) {
      equityPath.push(initialCapital * (series.byDate.get(dates[index]) / series.byDate.get(entryDate)));
    }
    const result = performanceMetrics({
      equitySeries: equityPath,
      dates: dates.slice(startIndex, endIndex + 1),
      initialCapital,
    });
    return { label, ...result };
  };

  return {
    window: {
      requested_start: String(input.backtest_start),
      requested_end: String(input.backtest_end),
      effective_start: dates[startIndex],
      effective_end: dates[endIndex],
      entry_date: entryDate,
      trading_days: endIndex - startIndex + 1,
      warmup_trading_days: startIndex,
      warmup_switch_signals: warmupSignals,
      start_date_adjusted: startWasAdjusted,
      adjustment_note: window.adjustment_note || '',
      warnings: window.warnings,
    },
    parameters: {
      lookback_days: lookback,
      upper_threshold_pp: upper,
      lower_threshold_pp: lower,
      cost_model: costModel,
      full_rebalance_cost_pct: flatCostPct,
      holding_threshold_days: costModel === 'holding_period' ? holdingThresholdDays : null,
      short_term_fee_pct: costModel === 'holding_period' ? shortTermFee : null,
      long_term_fee_pct: costModel === 'holding_period' ? longTermFee : null,
      asset_1: `${assetA} ${parameters.asset_1_name}`,
      asset_2: `${assetB} ${parameters.asset_2_name}`,
    },
    data_quality: {
      common_trading_days: dates.length,
      excluded_dates: excluded.length,
      excluded_samples: excluded.slice(0, 10),
      asset_1_rows: rowsA.length,
      asset_2_rows: rowsB.length,
      integrity,
    },
    summary: {
      initial_capital: round(initialCapital, 2),
      ...metrics,
      trade_count: trades.length,
      short_term_switches: trades.filter((t) => t.cost_tier === 'short').length,
      long_term_switches: trades.filter((t) => t.cost_tier === 'long').length,
      short_term_cost_paid: round(shortTermCostPaid, 2),
      long_term_cost_paid: round(longTermCostPaid, 2),
      win_rate_pct: trades.length === 0 ? null : round((winningTrades / trades.length) * 100, 2),
      total_cost_paid: round(totalCostPaid, 2),
      days_in_growth: daysInGrowth,
      days_in_value: curve.length - daysInGrowth,
      time_in_growth_pct: round((daysInGrowth / curve.length) * 100, 2),
      final_position: position,
      seed_position: seedPosition,
      derived_start_position: curve[0].position,
    },
    curve,
    trades,
    benchmarks: {
      growth_buy_hold: buildBenchmark(seriesA, `${parameters.asset_1_name} 买入持有`),
      value_buy_hold: buildBenchmark(seriesB, `${parameters.asset_2_name} 买入持有`),
    },
  };
}
