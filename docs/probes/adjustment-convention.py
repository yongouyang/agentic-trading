#!/usr/bin/env python3
"""Adjustment-convention probe — evidence behind phase-0-data-verification.md Appendix A.

Answers one question: can two providers' *adjusted* daily closes be compared at a
tight tolerance?  (They cannot.  Raw closes can.)

Free, no API key, stdlib only (python3).  Run:

    python3 docs/probes/adjustment-convention.py            # HK + US + LSE
    python3 docs/probes/adjustment-convention.py --no-eastmoney   # if eastmoney has IP-banned us

Measured verdict (2026-08-31, 0005.HK / 5y / daily):
  Yahoo adjclose is MULTIPLICATIVE  (2021 bar 41.45 -> 30.74)
  tencent/eastmoney qfq is ADDITIVE (-> 23.31 / 18.91), same anchor price today
  -> mean deviation -12.3%, max 40.2%, 86% of bars beyond 1%
  -> implied 5y total return +369.9% (Yahoo) vs +590.8% (tencent): 220pp
  -> raw closes agree: mean 0.00%, max 0.27%, 1226/1227 dates aligned
So: store raw + corporate actions, derive the adjusted series locally
(architecture-v1.md R1-R4).  Never compare or splice adjusted series across sources.

Note the request User-Agent: Yahoo 429s on a long Chrome UA and returns 200 on
this short one.  Both providers throttle by IP — keep the sleeps.
"""

import json
import statistics
import sys
import time
import urllib.request

UA = {"User-Agent": "Mozilla/5.0"}
RANGE_Y, RANGE_T = "5y", 1200


def fetch_json(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            return json.loads(urllib.request.urlopen(req, timeout=25).read().decode())
        except Exception as err:  # noqa: BLE001 - probe: report and retry
            if i == tries - 1:
                raise
            print(f"      retry {i + 1}: {type(err).__name__}")
            time.sleep(3 * (i + 1))
    raise AssertionError


def date(ts):
    return time.strftime("%Y-%m-%d", time.gmtime(ts))


def yahoo(sym):
    """Raw closes, provider-adjusted closes, dividend events (auto_adjust=false)."""
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{sym}?range={RANGE_Y}&interval=1d&auto_adjust=false&events=div%2Csplit"
    )
    d = fetch_json(url)["chart"]["result"][0]
    ts = [date(t) for t in d["timestamp"]]
    q = d["indicators"]["quote"][0]
    adj = d["indicators"]["adjclose"][0]["adjclose"]
    raw = {t: c for t, c in zip(ts, q["close"]) if c}
    adjusted = {t: v for t, v in zip(ts, adj) if v}
    divs = sorted(
        (date(v["date"]), v["amount"])
        for v in (d.get("events", {}).get("dividends", {}) or {}).values()
    )
    return raw, adjusted, divs, d["meta"].get("currency")


def yahoo_multiplicative_factor(raw, adjusted):
    d0 = min(raw)
    return adjusted[d0] / raw[d0]


def synthetic_additive(raw, divs):
    """Reproduce the CN 前复权 convention from Yahoo's own event list: anchor the
    newest bar at the real traded price and SUBTRACT every later dividend."""
    return {d: raw[d] - sum(a for (de, a) in divs if de > d) for d in raw}


def tencent_hk(code5):
    """HK daily bars.  NOTE: 5-digit code (hk00005) — Yahoo wants 4-digit (0005.HK).
    A wrong-but-plausible shape returns HTTP 200 with an EMPTY bar array, which must
    be typed FETCH_FAILED (bad request), never GENUINELY_ABSENT."""
    url = (
        "https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get"
        f"?param={code5},day,,,{RANGE_T},qfq"
    )
    node = fetch_json(url)["data"][code5]
    bars = node.get("qfqday") or node.get("day") or []
    if not bars:
        raise RuntimeError(f"empty bar array for {code5} (keys={list(node)})")
    return {b[0]: float(b[2]) for b in bars}  # [date, open, close, high, low, volume]


EASTMONEY_FIELDS = "f51,f53"  # date, close


def eastmoney_hk(secid6, fqt):
    """secid 116.00005 ; fqt 0=raw 1=前复权(additive, anchors newest)
    2=后复权(anchors oldest).  Throttles hard: ~5 rapid calls -> connection dropped."""
    url = (
        "https://push2his.eastmoney.com/api/qt/stock/kline/get"
        f"?secid=116.{secid6}&fields1=f1&fields2={EASTMONEY_FIELDS}"
        f"&klt=101&fqt={fqt}&beg=20210901&end=20260901"
    )
    kl = fetch_json(url)["data"]["klines"]
    return {row["f51"]: float(row["f53"]) for row in kl}


def compare(a, b, label):
    common = sorted(set(a) & set(b))
    if len(common) < 50:
        print(f"    {label}: only {len(common)} aligned bars — not comparable")
        return None
    dev = [(b[k] / a[k] - 1) * 100 for k in common]
    ad = [abs(x) for x in dev]
    print(
        f"    {label}: n={len(common)} mean={statistics.mean(dev):+.2f}% "
        f"max|dev|={max(ad):.2f}% bars>1%={sum(1 for x in ad if x > 1) / len(ad) * 100:.0f}% "
        f"| @oldest {dev[0]:+.1f}% @newest {dev[-1]:+.1f}%"
    )
    return common, dev


def momentum_error(common, a, b, win=20):
    errs = [
        abs((b[common[i]] / b[common[i - win]] - 1) * 100 - (a[common[i]] / a[common[i - win]] - 1) * 100)
        for i in range(win, len(common))
    ]
    if errs:
        print(
            f"    rolling {win}d momentum |error|: median {statistics.median(errs):.2f}pp, "
            f"p95 {sorted(errs)[int(len(errs) * 0.95)]:.2f}pp, max {max(errs):.2f}pp"
        )


UNIVERSE = [
    ("0005.HK", "hk00005", "00005", "HSBC  (HK, high yield)"),
    ("0700.HK", "hk00700", "00700", "Tencent (HK, low yield)"),
]

if "--no-eastmoney" in sys.argv:
    UNIVERSE = [(s, t, None, n) for s, t, _e, n in UNIVERSE]

for sym, tcode, esec, name in UNIVERSE:
    raw, adj, divs, ccy = yahoo(sym)
    time.sleep(0.5)
    tot = sum(a for _, a in divs)
    print(f"\n### {name}  [{ccy}]  div events={len(divs)} sum={tot:.2f}/share "
          f"({tot / raw[min(raw)] * 100:.1f}% of oldest price)")
    print(f"    raw  {min(raw)}={raw[min(raw)]:.2f} -> {max(raw)}={raw[max(raw)]:.2f}")
    print(f"    yahoo adj {min(adj)}={adj[min(adj)]:.2f} (factor "
          f"{yahoo_multiplicative_factor(raw, adj):.4f}) -> {max(adj)}={adj[max(adj)]:.2f}")
    fake = synthetic_additive(raw, divs)
    print(f"    synthetic additive (local reconstruction) oldest={fake[min(fake)]:.2f} "
          f"— proves the convention is reproducible from Yahoo's events alone")

    tq = None
    try:
        tq = tencent_hk(tcode)
        print(f"    tencent qfq oldest={min(tq)}={tq[min(tq)]:.2f} newest={max(tq)}={tq[max(tq)]:.2f}")
        res = compare(adj, tq, "ADJ vs tencent qfq   <- invalid comparison (was gate G2)")
        if res:
            momentum_error(res[0], adj, tq)
            tr = res[0]
            print(f"    5y total return from {tr[0]}: yahoo "
                  f"{(adj[tr[-1]] / adj[tr[0]] - 1) * 100:+.1f}% vs tencent "
                  f"{(tq[tr[-1]] / tq[tr[0]] - 1) * 100:+.1f}%")
    except Exception as err:  # noqa: BLE001
        print(f"    tencent: UNAVAILABLE ({err})")

    if esec:
        try:
            eraw, eqfq = eastmoney_hk(esec, 0), eastmoney_hk(esec, 1)
            time.sleep(1.5)
            print(f"    eastmoney raw oldest={eraw[min(eraw)]:.2f} qfq oldest={eqfq[min(eqfq)]:.2f} "
                  f"| (raw-qfq)@oldest={eraw[min(eraw)] - eqfq[min(eqfq)]:.2f} "
                  f"vs yahoo sum-div {tot:.2f} -> additive confirmed")
            compare(raw, eraw, "RAW vs eastmoney RAW  <- convention-free, this is G2a")
            compare(adj, eqfq, "ADJ vs eastmoney qfq <- invalid")
        except Exception as err:  # noqa: BLE001
            print(f"    eastmoney: UNAVAILABLE ({err}) — it IP-bans on bursts (A5)")

    time.sleep(0.6)

print("\n### Controls (Yahoo only): divergence scales with cumulative dividend")
for sym, label in [("MSFT", "US low yield"), ("CSPX.L", "LSE UCITS USD-accumulating")]:
    raw, adj, divs, ccy = yahoo(sym)
    tot = sum(a for _, a in divs)
    d0 = min(raw)
    print(f"    {sym:9s} [{ccy}] {label:28s} cum div {tot / raw[d0] * 100:5.1f}% of price, "
          f"adj factor {yahoo_multiplicative_factor(raw, adj):.4f}, {len(raw)} bars")
    time.sleep(0.5)
