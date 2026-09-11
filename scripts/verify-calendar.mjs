import fs from 'node:fs';

const expectedDate = process.argv[2];

if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDate || '')) {
  throw Error(`验收日期格式错误：${expectedDate || '(空)'}`);
}

const events = JSON.parse(fs.readFileSync('data/strategy-a.json', 'utf8'));
const event = events[0];
const jsonDate = event?.start?.slice(0, 10);
const description = event?.strategyDescription || '';
const ics = fs.readFileSync('public/calendar/GLOBAL_KEY.ics', 'utf8');
const compactDate = expectedDate.replaceAll('-', '');

const checks = [
  ['JSON 事件日期', jsonDate === expectedDate, jsonDate],
  ['信号交易日', description.includes(`信号交易日：${expectedDate}`), '缺失或不一致'],
  ['日历日期', description.includes(`日历日期：${expectedDate}`), '缺失或不一致'],
  ['ICS UID', ics.includes(`UID:strategy-a-${expectedDate}@value-growth-calendar`), '缺失或不一致'],
  ['ICS DTSTART', ics.includes(`DTSTART:${compactDate}T100500Z`), '缺失或不一致'],
];

const failed = checks.filter(([, ok]) => !ok);

if (failed.length) {
  throw Error(`日历一致性验收失败：${failed.map(([name, , actual]) => `${name}=${actual}`).join('；')}`);
}

console.log(`日历一致性验收通过：${expectedDate}`);
