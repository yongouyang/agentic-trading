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
.venv/bin/python scripts/futu/snapshot.py --days 30 --journal-csv logs/futu/trades.csv
```

Snapshot JSON: account, accinfo (USD + HKD), positions with live quotes,
open orders, recent fills, and an `asset_mix` block.

**Asset classes — "fund" means two different things here.** An ETF position
*is* a fund but is a priced security: it sits in `securities_assets` and has a
row in `positions`. The **money-market / mutual-fund** class (`fund_assets`,
currently the USD 576 money market fund) is a separate bucket with **no
position listing reachable through the API** — verified 2026-09-26: every
`TrdMarket` filter in `position_list_query` (`USFUND`, `HKFUND`, `NONE`) returns
0 rows for it, `deal_list_query` on those markets returns 0, every market filter
exposes only the one REAL account, and `futu-api` v10.11 ships no fund context
(only Sec/Future/Crypto/Quote). Its aggregate value is readable via
`accinfo.fund_assets`; its line items are app-only. Don't report "no fund
holdings" from an empty `positions` list.

`--journal-csv` writes the fills as the normalized CSV that `journal:link` reads
(`date,symbol,side,quantity,price`; non-`OK` deals skipped, no fee column):

```
pnpm -C apps/api journal:link -- --file "$PWD/logs/futu/trades.csv"
```

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

Market/holdings review — `scripts/futu/us_review.py` (read-only, no unlock).
One pass over ~55 endpoints, writes `logs/futu/us-review-<date>.json`:

```
.venv/bin/python scripts/futu/us_review.py                  # 7 default holdings
.venv/bin/python scripts/futu/us_review.py --codes US.SMH US.XLV
```

Market context (quotes for SPY/QQQ/IWM/DIA/RSP/TLT/GLD/VIXY + all 11 sector
ETFs incl. pre/after/overnight, breadth, top movers, hot list, after-hours rank,
rating changes, 14-day economic calendar, FedWatch, macro list) then per holding:
300 daily klines → MA20/50/200, RSI14, ATR%, 1/5/20/60/252-session change,
52w-high distance, stacked-MA state, volume ratio; plus 5d capital flow, capital
distribution, FINRA short volume, dividend history, `get_technical_unusual` and
`get_derivative_unusual` (both need `language_id=2` for English), and news by
theme + per ticker. Throttled to 8 calls/30 s; a full run is ~4 minutes.

The two traps it encodes, both of which cost real debug time: **payload arity and
nesting are not uniform** (`(ret, df)`, `(ret, (count, df))`, `(ret, df, page,
more)`, `(ret, us_df, hk_df)`) so a DataFrame must be located by scanning the
payload rather than by index — taking `res[1]` blindly yields a tuple that reads
as "endpoint returned nothing"; and `sanitize()` records any non-native value
under `unserializable_paths` instead of dropping it, so a silently-empty report
field can't masquerade as a missing endpoint.

Gotchas learned 2026-09-24:

- **Rate limits are per-endpoint and NOT uniform** — a single 30/30 s throttle
  is wrong and causes silent-looking failures. Observed 2026-09-26:
  quote endpoints ~30/30 s, but `get_stock_filter` **and** `position_list_query`
  cap at **10 per 30 s** ("Maximum 10 times per 30 seconds"). `enrich.py`'s
  30/30 s window is too permissive for those two; a burst poisons the whole
  30 s window, so back-to-back sweeps must space calls ~4 s.
- `SimpleFilter` needs `is_no_filter = False` or min/max are silently ignored.
- `get_stock_filter` returns `(ret, (last_page, count, [FilterStockData]))` —
  records stringify as `key:value  key:value`; parse `str(rec)`. The `US` market
  scans the whole US venue space including **OTC ADRs and SPACs**, so any filter
  set needs an explicit venue/instrument-type constraint to be tradeable-set.
  Measured 2026-09-26: `FLOAT_MARKET_VAL>=2e9` alone = 2832 names (OTC ADRs),
  `+VOLUME_RATIO>=2` = 110, `MA_ALIGNMENT_LONG(K_DAY,3d)` alone = 29 (SPACs and
  perpetual preferreds), all three together = **0** — the shipped discovery
  lane's intersection, which is why it has never produced a diff.
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
  — 133 `StockField`s computed server-side. Does NOT consume the kline quota.
  **Fields are split across three filter CLASSES and a mismatched pair fails with
  "This filter field is not supported" — which looks like a market limitation and
  is not one** (probed 2026-09-26, identical for HK and US):

  | filter class | needs | examples that work |
  |---|---|---|
  | `SimpleFilter` | `stock_field` | `PE_TTM`, `PB_RATE`, `PS_TTM`, `PCF_TTM`, `MARKET_VAL`, `FLOAT_MARKET_VAL`, `VOLUME_RATIO`, `CUR_PRICE_TO_HIGHEST52_WEEKS_RATIO` |
  | `FinancialFilter` | `stock_field` **+ `quarter`** (`FinancialQuarter.ANNUAL`) | `RETURN_ON_EQUITY_RATE`, `ROIC`, `ROA_TTM`, `GROSS_PROFIT_RATE`, `NET_PROFIT_RATE`, `EBIT_MARGIN`, `DEBT_ASSET_RATE`, `*_GROWTH_RATE`. **Not `StockField.ROE`** — that attribute does not exist |
  | `PatternFilter` | `stock_field` + `ktype` + `consecutive_period` | `MA_ALIGNMENT_LONG/SHORT`, `RSI`, `MACD`/`KDJ`/`BOLL` and their crosses & divergences |

  `is_no_filter = False` is required on all three or min/max are silently ignored.
  Verified live on HK: `FinancialFilter(RETURN_ON_EQUITY_RATE ≥ 15)` → 349
  matches; `+ SimpleFilter(PE_TTM 0.1–20)` → 273; `+ PatternFilter(MA bullish 3d)`
  `+ FLOAT_MARKET_VAL ≥ 2e9` → **154 credible mid/large caps**. Without a
  market-cap floor the matches are dominated by micro-caps, so always pair a
  fundamental filter with one. Rate cap is **10/30 s** — a 4-query funnel is
  fine, a 17-field sweep is not.
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

## HK market-data surface (probed live 2026-09-26, account HK **LV1**)

US rights are LV3, HK is LV1 — the difference is real and is not a bug. Answering
this empirically (one sweep over ~45 endpoints, HK.00700 as the subject) rather
than from the US list, because half the US surface does not transfer.

**Works for HK** (values are Friday 2026-09-25 close unless noted):

- **Quotes**: `get_market_snapshot` (00700 = 436.60), `get_market_state`
  (`CLOSED`), `request_history_kline` (daily, carries `pe_ratio` per bar)
- **Flows**: `get_capital_flow` (245 rows, split super/big/mid/small in *and*
  out), `get_capital_distribution`
- **Ranks/breadth**: `get_rise_fall_distribution(market=Market.HK)`,
  `get_hot_list` (top hits carry an attached `news_title`/`news_url`),
  `get_top_movers_rank` (615), `get_period_change_rank` (2822),
  `get_heat_map_data` (industry heat map)
- **HK-only analytics** (no US equivalent — most valuable part of this list):
  - `get_top_ten_buy_sell_brokers(code)` — real-time broker-name flow,
    **works at LV1**
  - `get_owner_plate(code_list)` — 24 concept/industry plates per name
    (e.g. 00700 → "Remote Work")
  - `get_warrant(stock_owner)` — HK warrants/CBBCs on the underlying
    (e.g. `HK.13005 SGTENCT@EC2703A.C`)
  - `get_industrial_chain_list(market)` — up/mid/down industry chains (AI…)
  - `get_rehab(code)` — 26 corporate-action rows for 00700 back to 2005, with
    split ratios and `per_cash_div`
  - `get_dividend_rank(market, DividendRankType.HIGH_YIELD)`,
    `get_high_dividend_soe_rank` (88 rows, PETROCHINA…)
- **Corporate actions**: `get_corporate_actions_dividends` (HKD amounts with
  `record_date`/`ex_date`/payable), `get_corporate_actions_stock_splits`
  (`rate` as `"1→5"`)
- **Earnings/financials**: `get_earnings_calendar(market=Market.HK, …)` — rich
  (79 events in one week; `eps_actual/eps_predict`, `revenue_*`, `ebit_*`,
  `iv_rank`, `iv_percentile`, `pub_type` REGULAR/AFTER). **Window is capped at
  7 days** — a longer range errors with "Date range must not exceed 7 days".
  Also `get_earnings_beat_rank` (72, with `earning_day_chg`),
  `get_financials_statements` (IAS, CNY, 23 fields with yoy/qoq),
  `get_financials_revenue_breakdown` (product split),
  `get_company_profile`, `get_company_executives`,
  `get_company_operational_efficiency`, `get_financials_earnings_price_history`
  (584), `get_financials_earnings_price_move` (110)
- **Research**: `get_research_analyst_consensus` (00700 STRONG_BUY, avg PT
  663.69) and `get_research_morningstar_report` (**both work for HK stocks** —
  5 stars, qualitative, economic moat), `get_valuation_detail` (PE 14.64 vs 1y
  avg 19.45 with ±1sd bands + market/plate distribution),
  `get_shareholders_overview` (main holders)
- **News**: `get_search_news` answers for Chinese and English keywords
  (腾讯 / Tencent / 港股 / 恒生指数), with `related_securities`;
  `get_search_quote` resolves names to codes

**Does NOT work for HK** — each of these failed loudly, not emptily:

| endpoint | error |
|---|---|
| `get_rt_ticker`, `get_order_book` | needs `subscribe(...)` (LV1 depth) |
| `get_broker_queue` | "does not support getting broker queue under LV1 permission" |
| `get_daily_short_volume`, `get_short_interest` | return **0 rows** — FINRA data, US-only (columns are even US-shaped: `nasdaq_shares_short`/`nyse_shares_short`) |
| `get_research_rating_summary` | "Only US stocks and REITs are supported" |
| `get_rating_change(market="HK")` | "This market does not support this feature" |
| `get_insider_trade_list` | "does not support Stocks in HK Market" |
| `get_holding_change_list` | upstream-provider outage (global, not HK-specific) |

**Two findings that matter beyond this skill:**

1. **HK fundamentals may have a real PIT anchor after all.** Phase 7's E2a probe
   came back NEGATIVE against eastmoney F10 (no announcement date → HK
   fundamentals are stored as `periodEnd + 90d`, `filedAtSynthetic=1`).
   `get_financials_earnings_price_history` exposes **`pub_trading_day`,
   `pub_time` and `pub_type` per reporting period** (e.g. FY2021/Q4 →
   2022-03-23), i.e. the actual publication date, 584 rows of it. The statement
   *values* live in `get_financials_statements`, whose own
   `date_time`/`date_time_str` is the **period end** (2026-06-30 for 2026/Q2),
   not a filing date. So PIT would require joining the two on
   `(fiscal_year, financial_type, period_text)`. **Unvalidated** — the join keys
   and cross-name coverage still need proving, and adopting a new fundamentals
   source is a pre-registered decision, not a patch.
2. **HK corporate actions are available cleanly here** (HKD-declared dividend
   amounts with ex/record/payable dates, plus a split registry and `get_rehab`).
   That is the class of data architecture §4 records as **broken at Yahoo for
   USD-declaring HK names** (`CA_DEGRADED`, patched via the weekly eastmoney F10
   overlay). Futu is a candidate third source for that overlay — again a
   decision, not a drop-in.

### HK research / selection material — what a "report" actually is here (probed 2026-09-26)

There is **no generic sell-side research-report (研报) endpoint** and no PDF corpus
search. What exists, in rough order of usefulness for "what is worth investing":

1. **The multi-factor screener above** — the only tool that ranks the whole HK
   market on quality + valuation + trend in one call, free, no kline quota. This
   is the real answer to "which stock", not a report feed.
2. **`get_search_news(kw, news_sub_type=...)`** — the subtype enum is the
   research feed, and it is worth knowing:
   - **`RATING`** — broker research summaries with ratings/targets, in English
     and Chinese ("Citi: Tencent… Maintains Buy"; "UBS lowers AIA TP to
     HK$102"; "Huatai: BOCHK credit boost + special dividend").
   - **`NOTICE`** — HKEX filings (`source: HKEX`); for a keyword like 腾讯 it is
     dominated by CBBC/warrant listing documents, so target it at a name.
   - `NEWS` — wire news; `ALL` — everything.
3. **`get_research_morningstar_report(code)` is a full research report for HK
   stocks**, not just the star/fair-value pair the US line returns:
   `star_rating` 5, `fair_value` 780, plus `economic_moat_content` (6052 chars),
   `investment_thesis_content` (2280), `analyst_note_content` (1896),
   `capital_allocation_content` (2224), `uncertainty_content`, `financial_health_content`,
   `bull_say` / `bear_say`, the named analyst (`analyst_report_by_line` = ['Ivan Su'])
   and **`pdf_url`** pointing at the actual PDF. Works for HK stocks; market-wide
   ETF/REIT coverage is not there.
4. **`get_research_analyst_consensus(code)`** — PT high/avg/low + rating (HK:
   00700 STRONG_BUY, avg 663.69).
5. **`get_valuation_plate_stock_list(plate_code, ValuationType.PE, num=…)`** —
   every stock in an industry ranked by valuation, **with `valuation_percentile`**
   (i.e. cheap/expensive vs its own history). Pair with `get_valuation_detail`
   for the ±1sd bands. This is the Phase-7 "valuation is a ceiling" leg, pre-built.
6. **`get_institution_list(market, …)` → `get_institution_profile` /
   `get_institution_distribution` / `get_institution_holding_change`** — large
   *holders*, not analyst firms (HK top: Central Huijin HK$4.51trn, 12 positions;
   its distribution is 96.0% Banks). `holding_change` returned 0 rows.
7. **`get_financial_unusual(code)`** — a capital-flow anomaly narrative
   ("Extra large trades recorded a net outflow of 60.09M…"), English with
   `language_id=2`. Complements `get_technical_unusual`.
8. **Ranks**: `get_earnings_beat_rank` (with `earning_day_chg`),
   `get_dividend_rank(HIGH_YIELD)`, `get_high_dividend_soe_rank`,
   `get_hot_list`, `get_top_movers_rank`, `get_period_change_rank`,
   `get_heat_map_data`.

**Fails for HK**: `get_research_rating_summary` (US stocks and REITs only),
`get_rating_change` ("This market does not support this feature"),
`get_insider_trade_list` (US only) — so per-name *consensus* and the *Morningstar
report* exist for HK but the market-wide *rating-change* feed does not.

**Gotcha:** `get_industrial_plate_stock` / `get_industrial_plate_info` take a
**numeric `plate_id`** and reject the `HK.LIST1079` code form with
`invalid literal for int() with base 10`. Strip the `HK.LIST` prefix.

**Not available at all:** Futubull AI chat (app-only), ETF constituents, and any
endpoint that returns a research PDF other than via Morningstar's `pdf_url`.
