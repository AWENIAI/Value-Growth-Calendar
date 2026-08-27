import fs from 'node:fs';

const data = JSON.parse(fs.readFileSync('data/strategy-a.json', 'utf8'))[0];
const escape = value => String(value ?? '').replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,').replaceAll('\n', '\\n');
const formatDate = value => value.replace(/[-:]/g, '').replace('+08:00', '');
const timestamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
const ics = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//AWENIAI//Value Growth Calendar//ZH-CN','CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:策略 A 日历','X-WR-TIMEZONE:Asia/Shanghai','BEGIN:VEVENT',`UID:strategy-a-${data.start.slice(0,10)}@value-growth-calendar`,`DTSTAMP:${timestamp}`,`DTSTART;TZID=Asia/Shanghai:${formatDate(data.start)}`,`DTEND;TZID=Asia/Shanghai:${formatDate(data.end)}`,`LOCATION:${escape(data.location)}`,`SUMMARY:${escape(data.title)}`,`DESCRIPTION:${escape(data.strategyDescription)}`,'CATEGORIES:策略 A','TRANSP:TRANSPARENT','BEGIN:VALARM','TRIGGER;RELATED=START:-PT10M','ACTION:DISPLAY',`DESCRIPTION:${escape(data.title)}`,'END:VALARM','END:VEVENT','END:VCALENDAR',''].join('\r\n');
fs.mkdirSync('public/calendar',{recursive:true}); fs.mkdirSync('docs',{recursive:true});
fs.writeFileSync('public/calendar/GLOBAL_KEY.ics', ics); fs.writeFileSync('public/GLOBAL_KEY.ics', ics); fs.writeFileSync('docs/GLOBAL_KEY.ics', ics);
console.log('GLOBAL_KEY.ics: generated in public, public/calendar, and docs');
