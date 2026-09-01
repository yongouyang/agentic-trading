# Research: Broker-provided market data (IBKR, Futu) — 2026-09-01

**Question:** do Interactive Brokers or Futu/moomoo provide *free* market data
for HK/US markets usable by the v1 pipeline?
**Answer:** no — neither changes the v1 routing table. Both stay in the
"Later (Phase 4 / broker era)" row of `architecture-v1.md` §4.1. Details below.

## Interactive Brokers

- Free tier = **10–15 min delayed streaming ticks** only, no subscription
  required ([TWS API docs](https://interactivebrokers.github.io/tws-api/delayed_data.html)).
  The same doc states **historical data requires paid market data
  subscriptions** — and the pipeline needs daily bars, i.e. historical data.
- Subscriptions are per-exchange, monthly, non-pro vs pro priced (IBKR's fee
  schedule is authoritative; not quoted here).
- Operational weight even when paid: open account + **TWS/IB Gateway running
  as a local desktop process**, plus strict pacing limits — IBKR explicitly
  positions itself as "not a data provider"
  ([groups.io/twsapi](https://groups.io/g/twsapi/topic/best_practices_for_pulling/109920971)).
- The Client Portal Web API is REST (TS-friendly) but carries the same
  subscription requirements.
- **Verdict:** the only genuine *single-provider* option for all three lanes
  (HK + US + LSE) once the user is a paying customer — that is Phase 4.
  Not free, not v1.

## Futu / moomoo (OpenAPI)

Source: [Authorities and Quota](https://openapi.futunn.com/futu-api-doc/en/intro/authority.html).

- Free quote rights are real: **HK securities LV1 free** (global users),
  **US LV3 free** during promotion (Nasdaq Basic + TotalView + ArcaBook).
- Blocker 1 — **historical candlestick quota** (tickers per rolling 7 days):
  100 (assets < HK$10k) · 300 (≥ HK$10k) · 1000 (> HK$500k assets, or >200
  filled orders/month, or >HK$2M monthly volume). An ~800-ticker daily screen
  needs the 1000 tier ⇒ Futu as a bulk feed implicitly costs HK$500k parked
  or heavy trading activity. Fine for per-ticker repair; not a primary.
- Blocker 2 — **no LSE coverage at all** (UK is not in the support table) ⇒
  can never serve the UCITS lane.
- Blocker 3 — stack friction: official SDK is Python over a local **OpenD
  desktop gateway** (login required). Pure-TS usage means an unofficial
  community client or a Python sidecar — excluded by the v1 architecture.
- **Verdict:** plausible HK/US **repair-tier** source in the broker era
  (healthier posture than eastmoney/tencent), kept out of v1 by quota, no-LSE,
  and the protocol/Python friction.

## Consequence for the routing table

None. "Free" ends at Yahoo regardless. When the broker era arrives: **Futu =
quota-capped repair source (HK/US only); IBKR = the only true primary
candidate (all lanes), at the cost of monthly per-exchange subscriptions.**
