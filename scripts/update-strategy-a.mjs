import fs from 'node:fs';

const api = 'http://hq.cnindex.com.cn/market/market/getIndexDailyDataWithDataFormat';

const indexMeta = {
  '480080': ['成长100R', 'CNIG100 TRI'],
  '480081': ['价值100R', 'CNIV100 TRI'],
  '980080': ['成长100', 'CNIG100'],
  '980081': ['价值100', 'CNIV100'],
};

const codePairs = {
  growth: ['480080', '980080'],
  value: ['480081', '980081'],
};

const beijingToday = () => {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const dict = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return dict.year + '-' + dict.month + '-' + dict.day;
};

const get = async code => {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const response = await fetch(`${api}?indexCode=${code}&startDate=${startDate}&endDate=${endDate}&frequency=day`);

  if (!response.ok) {
    throw Error(`${code} HTTP ${response.status}`);
  }

  const { data } = await response.json();
  const expected = indexMeta[code];

  if (!expected) {
    throw Error(`${code} 未配置口径校验`);
  }

  if (data?.indexCode !== code || data.indexName !== expected[0] || data.indexEName !== expected[1]) {
    throw Error(`${code} 口径校验失败`);
  }

  const closeIndex = data.item.indexOf('close');

  if (closeIndex < 0) {
    throw Error(`${code} 缺少 close 字段`);
  }

  return Object.fromEntries(data.data.filter(row => row[closeIndex] != null).map(row => [row[0], Number(row[closeIndex])]));
};

const getWithFallback = async (label, codes) => {
  const errors = [];

  for (const code of codes) {
    try {
      const series = await get(code);
      return { code, series };
    } catch (error) {
      errors.push(`${code}: ${error.message}`);
    }
  }

  throw Error(`${label} 数据获取失败（已尝试 ${codes.join(' / ')}）：${errors.join('；')}`);
};

const event = (title, description, date) => ({
  market: 'CN',
  level: 'high',
  category: 'Strategy A',
  title,
  start: `${date}T15:20:00+08:00`,
  end: `${date}T15:25:00+08:00`,
  location: '中国',
  assets: ['成长100R', '价值100R'],
  sourceUrl: 'https://www.cnindex.com.cn/',
  strategyDescription: description,
});

try {
  const [growthResult, valueResult] = await Promise.all([
    getWithFallback('成长100R', codePairs.growth),
    getWithFallback('价值100R', codePairs.value),
  ]);
  const g = growthResult.series;
  const v = valueResult.series;
  const ds = Object.keys(g).filter(date => date in v).sort();

  if (ds.length < 21) {
    throw Error('共同有效交易日不足21个');
  }

  const date = ds.at(-1);
  const eventDate = date < beijingToday() ? beijingToday() : date;
  const isStaleData = eventDate !== date;
  const previous = ds.at(-2);
  const old = ds.at(-21);
  const rg = g[date] / g[old] - 1;
  const rv = v[date] / v[old] - 1;
  const d = (rg - rv) * 100;
  const state = JSON.parse(fs.readFileSync('data/strategy-a-state.json'));
  const previousPosition = state.currentPosition;

  if (!['VALUE', 'GROWTH'].includes(previousPosition)) {
    throw Error('当前持仓状态无效');
  }

  const targetPosition =
    previousPosition === 'VALUE' && d > 1
      ? 'GROWTH'
      : previousPosition === 'GROWTH' && d < -1
        ? 'VALUE'
        : previousPosition;

  const result =
    targetPosition !== previousPosition
      ? targetPosition === 'GROWTH'
        ? '从价值切换到成长'
        : '从成长切换到价值'
      : previousPosition === 'VALUE'
        ? '保持当前价值'
        : '保持当前成长';

  const holding = targetPosition === 'GROWTH' ? '成长100R' : '价值100R';
  const displayResult = targetPosition !== previousPosition ? result : `保持当前“${holding}”持仓`;
  const title = isStaleData
    ? `💰 策略A-成长100R价值100R轮动：数据源未更新，沿用 ${date} 信号`
    : `💰 策略A-成长100R价值100R轮动：${displayResult}`;
  const reason = isStaleData
    ? `数据源尚未更新到 ${eventDate}，本次只提醒“暂无当日新信号”，不改变持仓状态。最新可用信号交易日为 ${date}。`
    : targetPosition !== previousPosition
      ? `成长100R的20日收益减去价值100R的20日收益，得到${d >= 0 ? '+' : ''}${d.toFixed(4)}pp。因此在下一交易日从“${previousPosition === 'VALUE' ? '价值' : '成长'}”切换至“${targetPosition === 'GROWTH' ? '成长' : '价值'}”。`
      : '因此保持当前持仓。';
  const sourceLine =
    growthResult.code === '480080' && valueResult.code === '480081'
      ? '数据口径：480080 / 480081'
      : `数据口径：${growthResult.code} / ${valueResult.code}（480080/480081 取数失败时使用 980080/980081 备用代码；备用代码为价格指数口径）`;
  const desc = `信号交易日：${date}\n日历提醒日：${eventDate}\n${isStaleData ? '状态：数据源尚未更新到今天，本次不产生新换仓信号。\n\n' : ''}成长100R（${growthResult.code}）：${g[date].toFixed(4)}      ${((g[date] / g[previous] - 1) * 100) >= 0 ? '+' : ''}${((g[date] / g[previous] - 1) * 100).toFixed(4)}%\n价值100R（${valueResult.code}）：${v[date].toFixed(4)}      ${((v[date] / v[previous] - 1) * 100) >= 0 ? '+' : ''}${((v[date] / v[previous] - 1) * 100).toFixed(4)}%\n${sourceLine}\n\n成长20日累计收益：${(rg * 100).toFixed(4)}%\n价值20日累计收益：${(rv * 100).toFixed(4)}%\n相对收益差：${d >= 0 ? '+' : ''}${d.toFixed(4)}pp\n\n理由：${reason}`;

  fs.writeFileSync('data/strategy-a.json', JSON.stringify([event(title, desc, eventDate)], null, 2) + '\n');
  fs.writeFileSync('data/strategy-a-state.json', JSON.stringify({
    currentPosition: targetPosition,
    tradeCount: state.tradeCount + Number(!isStaleData && targetPosition !== previousPosition),
    lastSignalDate: date,
    lastResult: isStaleData ? '数据源未更新' : result,
  }, null, 2) + '\n');
  console.log(title);
  console.log(sourceLine);
} catch (error) {
  const date = beijingToday();
  fs.writeFileSync('data/strategy-a.json', JSON.stringify([event(
    '💰 策略A-成长100R价值100R轮动：数据错误无结果',
    `结果：数据错误无结果\n\n数据口径：480080 / 480081；备用代码：980080 / 980081\n\n理由：${error.message}`,
    date,
  )], null, 2) + '\n');
  console.error(error.message);
  process.exitCode = 1;
}
