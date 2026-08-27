# 策略 A｜成长100R × 价值100R

策略 A 由仓库根目录的 GitHub Actions 统一执行，并合并到公开的 `GLOBAL_KEY.ics` 订阅日历。

目标：在每个交易日北京时间 15:10 获取 480080 / 480081 TRI 数据，执行双阈值滞回状态机，并通过 GitHub Pages 推送到 Apple 日历订阅。

## 方案结构

- `scripts/risk-calendar/update-strategy-a.mjs`：获取官方数据、计算状态并生成事件 JSON。
- `data/strategy-a.json`：当前策略 A 日历事件。
- `data/strategy-a-state.json`：持仓状态和换仓次数。
- `scripts/risk-calendar/generate-risk-calendar.mjs`：将事件合并到 `public/calendar/GLOBAL_KEY.ics`。
- `.github/workflows/update-calendar-feed.yml`：15:10 云端定时任务和 Pages 发布。

## 运行方式

本地验证：

```bash
cd a-share-tailclose-monitor
npm run update-strategy-a
npm run generate
```

GitHub Actions 会在每个工作日 15:10 北京时间运行，对应 `07:10 UTC`。GitHub 的定时任务可能存在几分钟延迟。

## 依赖

- Node.js 20+
- 国证指数官方接口

## 输出

程序会生成：

- `data/strategy-a.json`
- `data/strategy-a-state.json`
- `public/calendar/GLOBAL_KEY.ics`

## 可执行边界

结果固定为：从价值切换到成长、从成长切换到价值、保持当前价值、保持当前成长、数据错误无结果。数据校验失败时不生成有效切换结论。
