#!/usr/bin/env python3
"""策略A · NAV 数据源（替代国证官网 980080/980081）
抓取实盘持有基金 027859(易方达国证成长100ETF联接C) / 026936(大成国证价值100指数C)
的净值历史，写出 worbuddy/forward/close-input-nav.csv (date,g,v)，供 sync.mjs NAV 模式使用。
CVM 上运行（东财基金接口不被反爬封），无需 Mac、无需代理、无需 token。
"""
import akshare as ak
import pandas as pd
import os

CODE_G = "027859"  # 易方达国证成长100ETF联接C（成长腿）
CODE_V = "026936"  # 大成国证价值100指数C（价值腿）
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "forward", "close-input-nav.csv")


def nav_series(code):
    df = ak.fund_open_fund_info_em(symbol=code, indicator="单位净值走势")
    df = df[["净值日期", "单位净值"]].copy()
    df["净值日期"] = pd.to_datetime(df["净值日期"]).dt.strftime("%Y-%m-%d")
    df["单位净值"] = df["单位净值"].astype(float)
    return df.sort_values("净值日期").reset_index(drop=True)


def main():
    g = nav_series(CODE_G)
    v = nav_series(CODE_V)
    m = g.merge(v, on="净值日期", how="inner", suffixes=("_g", "_v"))
    m = m.rename(columns={"净值日期": "date", "单位净值_g": "g", "单位净值_v": "v"})
    if m.empty:
        raise SystemExit("❌ 两只基金净值取数均为空，请检查网络/akshare")
    # 合并已有历史（按日期去重）
    existing = pd.DataFrame(columns=["date", "g", "v"])
    if os.path.exists(OUT):
        existing = pd.read_csv(OUT, dtype={"date": str})
    combined = (
        pd.concat([existing, m], ignore_index=True)
        .drop_duplicates(subset=["date"])
        .sort_values("date")
        .reset_index(drop=True)
    )
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    combined.to_csv(OUT, index=False)
    print(
        f"✅ NAV 行数={len(combined)} 最新={combined['date'].iloc[-1]} "
        f"成长={combined['g'].iloc[-1]} 价值={combined['v'].iloc[-1]}"
    )


if __name__ == "__main__":
    main()
