---
name: futu
description: Manage the user's Futubull HK account via local Futu OpenD — portfolio snapshots, positions, fills, and placing/modifying/cancelling US stock & ETF orders. Use whenever the user asks about their Futu portfolio, buying/selling ETFs or US stocks through Futu, order status, or anything requiring the local OpenD gateway.
---

# Futu (Futubull HK) local integration

Broker access runs through **Futu OpenD**, a local gateway at
`127.0.0.1:11111`. All scripts live in `scripts/futu/` and run with the
project venv: `.venv/bin/python`.

## Prerequisites (check before anything else)

1. **OpenD must be running** and logged in (GUI version). If it's not
   running, tell the user to start it — do not attempt to launch or log
   into OpenD yourself.
2. **Real orders require manual unlock**: the user must click **Unlock**
   in the OpenD GUI and enter their trading password once per OpenD
   session. The GUI version rejects API `unlock_trade` calls. Query APIs
   (positions, orders, fills, quotes) work without unlock.
3. If an order placement fails with an unlock/trade-permission error, ask
   the user to unlock in OpenD, then retry.

## Safety rules (non-negotiable)

- The CLI is **dry-run by default** — without `--live` (real) or `--sim`
  (paper), it only prints what it would do.
- **Live-price validation**: `buy`/`sell`/`modify --price` fetch the live
  quote first and reject BUY limits at/above market and SELL limits
  at/below market. Only passive limit orders are possible; if a quote
  can't be fetched, the order is refused.
- For REAL orders: always show the dry-run output first and get the
  user's explicit go-ahead before re-running with `--live`. A direct,
  fully-specified instruction from the user ("buy 1 XLV at 169.6 GTD")
  counts as the go-ahead; ambiguous requests do not.
- Limit orders only (`NORMAL` order type). No market orders.
- After submitting, report the order_id and status; the user gets fill
  notifications in the Futubull mobile app — no need to poll.

## Commands

Order CLI — `scripts/futu/order.py`:

```
.venv/bin/python scripts/futu/order.py buy US.QQQM 1 --price 300           # dry-run
.venv/bin/python scripts/futu/order.py buy US.QQQM 1 --price 300 --live    # real order
.venv/bin/python scripts/futu/order.py sell US.XLV 1 --price 180 --sim     # paper account
.venv/bin/python scripts/futu/order.py buy US.XLV 1 --price 169.6 --tif GTD --expire 2026-10-23 --live
.venv/bin/python scripts/futu/order.py modify <order_id> --price 170 --live   # change limit/qty in place
.venv/bin/python scripts/futu/order.py cancel <order_id> --live
.venv/bin/python scripts/futu/order.py list                                 # open orders
```

Portfolio snapshot — `scripts/futu/snapshot.py` (read-only, no unlock):

```
.venv/bin/python scripts/futu/snapshot.py                    # JSON to stdout
.venv/bin/python scripts/futu/snapshot.py --out logs/futu/   # write file
.venv/bin/python scripts/futu/snapshot.py --days 30          # fill history window
```

Snapshot JSON: account, accinfo (USD + HKD), positions with live quotes,
open orders, recent fills.

Screen enrichment — `scripts/futu/enrich.py` (read-only, no unlock). Wired
into `scripts/daily-chain.sh` after a successful screen leg (non-fatal):

```
.venv/bin/python scripts/futu/enrich.py --report apps/api/reports/2026-09-24-US.json
```

Reads the screen report's shortlist and writes `logs/futu/enrich-<date>-<lane>.json`:
per-symbol capital flow (5d net main inflow), daily short ratio + 5d avg,
earnings within 30d (flagged if ≤ 7d), analyst consensus, Morningstar
stars/fair value (both null for ETFs), plus a **discovery lane** —
server-side `get_stock_filter` (float mcap ≥ $2B + volume ratio ≥ 2 +
MA bullish alignment 3d) diffed against the quant-core shortlist.

Gotchas learned 2026-09-24:

- **Rate limit: 30 calls/endpoint per 30 s** — the script throttles with a
  per-endpoint sliding window; don't parallelize it.
- `SimpleFilter` needs `is_no_filter = False` or min/max are silently ignored.
- `get_stock_filter` returns `(last_page, count, [FilterStockData])` — records
  stringify as `key:value  key:value`; parse `str(rec)`.
- `StockField.CUR_PRICE_TO_HIGHEST52_WEEKS_RATIO` is broken for US (top
  "matches" were OTC ADRs at nonsense values) — do not use it.
- A dead OpenD makes SDK queries block forever; enrich.py probes via a
  subprocess with a hard timeout (must call `ctx.close()` before exit or the
  SDK network thread hangs the probe process).
- `FUTU_HOST` / `FUTU_PORT` env vars override the default gateway address.


## API notes (if writing new code)

- SDK: `futu-api` v10.11 in `.venv/`. Use
  `OpenSecTradeContext(filter_trdmarket=TrdMarket.US, security_firm=SecurityFirm.FUTUSECURITIES)`
  — the old `OpenUSTradeContext` is gone.
- Cancel/amend both go through `modify_order` (`ModifyOrderOp.CANCEL` /
  `ModifyOrderOp.NORMAL`); there is no `cancel_order`.
- GTD orders: `time_in_force='GTD'` + `expire_time='YYYY-MM-DD'` (date
  only, no time component).
- Session: orders default to `session='ETH'` (US regular hours + pre/post
  market). Do NOT default to `ALL` — it includes the overnight session,
  which requires a separate risk-disclosure acknowledgment and is
  rejected until the user accepts it in the app. `OVERNIGHT` alone is
  night-session only. `RTH` is regular hours only.
- accinfo values come back consolidated in HKD unless
  `currency=Currency.USD` is passed; position `cost_price` is in USD.
- Silence SDK INFO logging with `logging.disable(logging.WARNING)` so
  stdout stays clean.
- Paper account: `trd_env=TrdEnv.SIMULATE` — use it to validate any new
  write-path code before touching REAL.

## Market-data surface (surveyed 2026-09-24, account VIP v1)

Quote rights: **US LV3** (Nasdaq Basic + TotalView + ArcaBook depth), HK LV1.
History kline quota: 300 tickers / rolling 7 days (HK$10k+ asset tier).

Verified working endpoints (`OpenQuoteContext`):

- **Depth/quotes**: `get_order_book` (real TotalView depth — must
  `subscribe([code],[SubType.ORDER_BOOK])` first), `get_rt_ticker`,
  `get_market_snapshot`, `get_broker_queue`
- **Server-side screener**: `get_stock_filter(market, filter_list, begin, num)`
  — 133 `StockField`s computed server-side (MA5–250, EMA, RSI, MACD/KDJ/BOLL
  incl. crosses & divergences, 52w-high/low ratios, volume ratio, turnover
  rate, PE/PB/PS, ROE/ROIC, growth rates). Does NOT consume the kline quota.
- **Flows/short**: `get_capital_flow` (minute-level main in/outflow),
  `get_capital_distribution`, `get_daily_short_volume` (FINRA short ratio),
  `get_short_interest` (biweekly)
- **Research**: `get_research_analyst_consensus` (PT high/avg/low +
  buy/hold/sell %), `get_research_morningstar_report` (star rating, fair
  value, full thesis text), `get_research_rating_summary`,
  `get_insider_trade_list` (Form 4/144), `get_ark_fund_holding`,
  `get_institution_holding_list/change`
- **Macro**: `get_macro_indicator_list(MacroRegion.US)` +
  `get_macro_indicator_history` (CPI/PPI/PCE/jobs/consumer series),
  `get_economic_calendar(begin_date, end_date)`, `get_fed_watch_target_rate`
  (CME probabilities), `get_fed_watch_dot_plot` (FOMC dots)
- **Calendars/ranks**: `get_earnings_calendar`, `get_dividend_calendar`,
  `get_us_pre_market_rank` / `get_us_after_hours_rank` /
  `get_us_overnight_rank`, `get_heat_map_data`, `get_hot_list`,
  `get_technical_unusual`, `get_financial_unusual`
- **News**: `get_search_news(keyword)`

NOT available: **Futubull AI chat** (app-only, no API endpoint), ETF
constituents/holdings (except ARK funds via `get_ark_fund_holding`),
ETF valuation ratios.
