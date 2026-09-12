#!/usr/bin/env python3
"""P2/P3 split classification of liquid-universe jumps, read from the DB.

Recorded next step from docs/research-xnys-fresh-cross-section.md §8 item 2:
the 2026-09-11 scoping session found 394 close-to-close jumps (>= +50% or
<= -40%) across 247 of the 1,844 liquid VendorBar series; the SplitEvent
registry explains 152; 240 were unexplained, and the P1 lattice tier of the
vendor split detector is degenerate (702 lattice points, median log-gap
0.0057 << LOG_TOL_NEAR 0.025), so discrimination must come from the
detector's P2 (volume persistence) and P3 (price/plausibility floors) tiers.
The shipped detector reads the raw .zst archive via a pickle; this script
re-derives everything from apps/api/prisma/dev.db, OPENED READ-ONLY.

Gates reused verbatim from scripts/databento/xnys_split_detector.py
(which itself carries split_candidate_detector.py v3's gates):
  P3 floors (lines 33-35, 89-90): MIN_PRICE = 0.10 on both prev close and
      ex-day open; MIN_ABS_MOVE = 0.05 on |open - prevClose|; factors must
      satisfy |k-1| >= MIN_FACTOR_DEV = 0.3 (line 33/44: lattice excludes
      the 0.7..1.43 band; the 0.72 < r < 1.39 early-skip is at line 92-93).
  P2 volume persistence (lines 98-113): pre-median = median volume over the
      10 tradeable bars before the event (need >= 3, med > 0); day_ratio =
      v(t)/med_pre; persist_ratio = median(v over t+1..t+5)/med_pre (need
      >= 3 post bars). NEAR factors (0.5 <= k <= 4, NEAR_LO/HI line 31):
      both |day_ratio/k - 1| and |persist_ratio/k - 1| <= VOL_TOL = 0.55
      (line 32, 107-111). FAR factors: direction-only persistence gate,
      (persist_ratio - 1) * (k - 1) > 0 (lines 112-114).
  Factor estimate: nearest split-ratio lattice point to r = prevClose/open
      in log space, tiered tolerance LOG_TOL_NEAR = 0.025 (NEAR) /
      LOG_TOL_FAR = 0.17 (FAR) (lines 29-30, best_candidate lines 54-71).
      NOTE: per the scoping session the lattice match ALONE is meaningless
      (any r matches some point); the factor is only used to pick the P2
      tier, and a jump is called split-like only if P3 + P2 also pass.
  Close-persistence gate (xnys_split_detector.py lines 119-131): over the
      ex-day close plus the next <= 3 tradeable closes (LOOKAHEAD = 3), with
      LOG_TOL_PERSIST = log(1.25) and MIN_HITS = 2: "bad-open-print" iff
      >= 2 closes persist at the PRE-split level and < 2 at prevClose/k.
  Ticker-reuse signature (lines 38-39, 115-118): calendar gap between the
      two bars > GAP_TICKER_REUSE_DAYS = 14 days is reported separately;
      these are overwhelmingly ticker-reuse artifacts, not splits.

Jump definition (reproduces the scoping session's 394 / 247 exactly):
close-to-close one-session return >= +50% or <= -40% within a liquid series.
Liquid universe (reproduces 1,844 series / 1,490 symbols exactly):
>= 252 bars AND adv20 = mean(close * volume) over the last 20 sessions
>= $20M on vendor volume.
Registry join (reproduces 152 explained exactly): same symbol, SplitEvent
exDate within +/- 1 day of the jump session date, any event/factor.

Outputs (CSV, matching the existing scripts' convention of writing next to
the script):
  scripts/databento/p2p3-jump-classification.csv  -- one row per jump
  scripts/databento/quarantine-gap-series.csv     -- the 27 gap-bearing series
Read-only on the store; writes nothing to the DB.
"""
import csv
import datetime
import math
import os
import sqlite3
import statistics
from bisect import bisect_left
from fractions import Fraction

DB = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                  "..", "..", "apps", "api", "prisma", "dev.db")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_JUMPS = os.path.join(HERE, "p2p3-jump-classification.csv")
OUT_QUAR = os.path.join(HERE, "quarantine-gap-series.csv")

# --- gates, verbatim from xnys_split_detector.py (lines 29-39) ---
LOG_TOL_NEAR = 0.025
LOG_TOL_FAR = 0.17
NEAR_LO, NEAR_HI = 0.5, 4.0
VOL_TOL = 0.55
MIN_FACTOR_DEV = 0.3
MIN_PRICE = 0.10
MIN_ABS_MOVE = 0.05
LOG_TOL_PERSIST = math.log(1.25)
LOOKAHEAD = 3
MIN_HITS = 2
GAP_TICKER_REUSE_DAYS = 14

# --- split-ratio lattice (lines 41-47) ---
_BASE = set(range(1, 33)) | {40, 50, 64, 65, 70, 80, 100}
CANDS = sorted({Fraction(n, d)
                for n in _BASE for d in _BASE
                if n != d and 0.01 <= n / d <= 100 and abs(n / d - 1) >= MIN_FACTOR_DEV},
               key=float)
_CAND_FLOATS = [float(f) for f in CANDS]
_CAND_LOGS = [math.log(x) for x in _CAND_FLOATS]

ADV_MIN = 20e6
MIN_BARS = 252
JUMP_UP, JUMP_DOWN = 0.50, -0.40
REGISTRY_WINDOW_DAYS = 1


def best_candidate(r):
    """Nearest lattice factor to r in log space, tiered tolerance
    (xnys_split_detector.py lines 54-71)."""
    if r <= 0:
        return None, None
    lr = math.log(r)
    i = bisect_left(_CAND_LOGS, lr)
    best, bestd = None, None
    for j in (i - 1, i):
        if 0 <= j < len(CANDS):
            dd = abs(_CAND_LOGS[j] - lr)
            if bestd is None or dd < bestd:
                best, bestd = CANDS[j], dd
    if best is None:
        return None, None
    k = float(best)
    tol = LOG_TOL_NEAR if NEAR_LO <= k <= NEAR_HI else LOG_TOL_FAR
    if bestd > tol:
        return None, None
    return best, bestd


def load_liquid(con):
    """Liquid universe: (vendor, symbol) -> list of (date, open, close, volume).
    >= 252 bars and adv20 = mean(close*volume) over last 20 sessions >= $20M."""
    groups = con.execute(
        "select vendor, symbol, count(*) from VendorBar "
        "group by vendor, symbol having count(*) >= ?", (MIN_BARS,)).fetchall()
    liquid = {}
    for vendor, sym, _n in groups:
        tail = con.execute(
            "select close, volume from VendorBar where vendor=? and symbol=? "
            "order by date desc limit 20", (vendor, sym)).fetchall()
        adv = sum(c * v for c, v in tail if c and v) / max(1, len(tail))
        if adv >= ADV_MIN:
            liquid[(vendor, sym)] = con.execute(
                "select date, open, close, volume from VendorBar "
                "where vendor=? and symbol=? order by date", (vendor, sym)).fetchall()
    return liquid


def find_jumps(series):
    """Close-to-close one-session moves >= +50% or <= -40%.
    Returns list of bar indices i (the jump session)."""
    out = []
    for i in range(1, len(series)):
        c0, c1 = series[i - 1][2], series[i][2]
        if c0 and c1 and c0 > 0:
            r = c1 / c0 - 1
            if r >= JUMP_UP or r <= JUMP_DOWN:
                out.append(i)
    return out


def classify_jump(series, i):
    """P3 floors -> factor estimate -> P2 volume persistence ->
    close-persistence, per xnys_split_detector.py lines 83-131.
    The jump itself is close-to-close; the detector's price ratio uses the
    ex-day OPEN vs prev close (r = c_prev / o_t), so a jump that happens
    intraday (open ~ prevClose) reads r ~ 1, fails P3's |k-1| floor, and is
    classified repricing — matching the detector's own behaviour."""
    d0, o, c_prev, v = series[i - 1][0], series[i][1], series[i - 1][2], series[i][3]
    d1 = series[i][0]
    res = dict(ex_date=d1, prev_date=d0, gap_days=None, factor=None,
               tier=None, vol_gate_day=None, vol_gate_persist=None,
               persistence="untestable", verdict="repricing", reason="")
    gap_days = (datetime.date.fromisoformat(d1)
                - datetime.date.fromisoformat(d0)).days
    res["gap_days"] = gap_days
    # P3 plausibility floors (lines 89-93)
    if o is None or v is None or c_prev < MIN_PRICE or o < MIN_PRICE:
        res["reason"] = "p3-min-price"
        return res
    if abs(o - c_prev) < MIN_ABS_MOVE:
        res["reason"] = "p3-open-equals-prevclose (intraday move)"
        return res
    r = c_prev / o
    if 0.72 < r < 1.39:
        res["reason"] = "p3-factor-band (|k-1| < 0.3)"
        return res
    f, dev = best_candidate(r)
    if f is None:
        res["reason"] = "p1-no-lattice-factor"
        return res
    k = float(f)
    res["factor"] = k
    res["tier"] = "NEAR" if NEAR_LO <= k <= NEAR_HI else "FAR"
    # P2 volume persistence (lines 98-114)
    pre = [series[j][3] for j in range(max(0, i - 10), i)
           if series[j][3] is not None]
    post = [series[j][3] for j in range(i + 1, min(len(series), i + 6))
            if series[j][3] is not None]
    if len(pre) < 3 or len(post) < 3:
        res["reason"] = "p2-insufficient-volume-window"
        return res
    med_pre = statistics.median(pre)
    if med_pre <= 0:
        res["reason"] = "p2-zero-pre-median-volume"
        return res
    day_ratio = v / med_pre
    persist_ratio = statistics.median(post) / med_pre
    res["vol_gate_day"] = day_ratio
    res["vol_gate_persist"] = persist_ratio
    if NEAR_LO <= k <= NEAR_HI:
        if abs(day_ratio / k - 1) > VOL_TOL or abs(persist_ratio / k - 1) > VOL_TOL:
            res["reason"] = "p2-volume-not-scaled (NEAR strict gates)"
            return res
    else:
        if (persist_ratio - 1) * (k - 1) <= 0:
            res["reason"] = "p2-volume-wrong-direction (FAR persistence)"
            return res
    # close-persistence gate (lines 119-131)
    window = [series[j][2] for j in range(i, min(len(series), i + 1 + LOOKAHEAD))
              if series[j][2] is not None and series[j][2] > 0]
    if len(window) >= MIN_HITS:
        implied = c_prev / k
        prev_hits = sum(1 for c in window
                        if abs(math.log(c / c_prev)) <= LOG_TOL_PERSIST)
        implied_hits = sum(1 for c in window
                           if abs(math.log(c / implied)) <= LOG_TOL_PERSIST)
        res["persistence"] = ("bad-open-print"
                              if prev_hits >= MIN_HITS and implied_hits < MIN_HITS
                              else "persistent")
        if res["persistence"] == "bad-open-print":
            res["reason"] = "close-persistence: bad open print"
            return res
    res["verdict"] = ("ticker-reuse-gap"
                      if gap_days > GAP_TICKER_REUSE_DAYS else "split-like")
    res["reason"] = "p3+p2 pass" + ("; gap > 14d" if res["verdict"] == "ticker-reuse-gap" else "")
    return res


def main():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    liquid = load_liquid(con)
    symbols = {s for _, s in liquid}
    print(f"liquid series: {len(liquid)}; distinct symbols: {len(symbols)}")

    sev = {}
    for sym, d in con.execute('select symbol, exDate from SplitEvent'):
        sev.setdefault(sym, []).append(d)

    jumps = []
    for (vendor, sym), series in sorted(liquid.items()):
        for i in find_jumps(series):
            jumps.append((vendor, sym, series, i))
    print(f"jumps: {len(jumps)} across "
          f"{len({(v, s) for v, s, _, _ in jumps})} series")

    rows = []
    n_reg = 0
    for vendor, sym, series, i in jumps:
        d1 = series[i][0]
        ret = series[i][2] / series[i - 1][2] - 1
        reg = any(abs((datetime.date.fromisoformat(d1)
                       - datetime.date.fromisoformat(d)).days)
                  <= REGISTRY_WINDOW_DAYS for d in sev.get(sym, []))
        if reg:
            n_reg += 1
            rows.append([vendor, sym, series[i - 1][0], d1, round(ret, 6),
                         "registry", "", "", "", "", "", "", "SplitEvent exDate within +/-1d"])
            continue
        c = classify_jump(series, i)
        rows.append([vendor, sym, c["prev_date"], c["ex_date"], round(ret, 6),
                     c["verdict"], c["tier"] or "",
                     round(c["factor"], 6) if c["factor"] else "",
                     round(c["vol_gate_day"], 4) if c["vol_gate_day"] is not None else "",
                     round(c["vol_gate_persist"], 4) if c["vol_gate_persist"] is not None else "",
                     c["gap_days"], c["persistence"], c["reason"]])

    with open(OUT_JUMPS, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["vendor", "symbol", "prev_date", "ex_date", "cc_return",
                    "classification", "p2_tier", "factor_est", "vol_gate_day",
                    "vol_gate_persist", "gap_days", "persistence", "reason"])
        w.writerows(rows)

    unexplained = [r for r in rows if r[5] != "registry"]
    print(f"explained by registry: {n_reg}; unexplained: {len(unexplained)}")
    for cls in ("split-like", "ticker-reuse-gap", "repricing"):
        sub = [r for r in unexplained if r[5] == cls]
        print(f"  {cls}: {len(sub)}")
    for tier in ("NEAR", "FAR"):
        sub = [r for r in unexplained if r[5] in ("split-like", "ticker-reuse-gap") and r[6] == tier]
        print(f"  split-like tier {tier}: {len(sub)}")

    # quarantine: series with an internal calendar gap > 14 days
    quar = []
    for (vendor, sym), series in sorted(liquid.items()):
        gaps = []
        for i in range(1, len(series)):
            g = (datetime.date.fromisoformat(series[i][0])
                 - datetime.date.fromisoformat(series[i - 1][0])).days
            if g > GAP_TICKER_REUSE_DAYS:
                gaps.append((series[i - 1][0], series[i][0], g))
        if gaps:
            worst = max(gaps, key=lambda g: g[2])
            quar.append([vendor, sym, series[0][0], series[-1][0], len(gaps),
                         worst[0], worst[1], worst[2],
                         ";".join(f"{a}->{b}({g}d)" for a, b, g in gaps)])
    with open(OUT_QUAR, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["vendor", "symbol", "first_date", "last_date", "n_gaps_gt14d",
                    "worst_gap_from", "worst_gap_to", "worst_gap_days", "all_gaps"])
        w.writerows(quar)
    print(f"quarantined series (gap > {GAP_TICKER_REUSE_DAYS}d): {len(quar)}")
    print(f"-> {OUT_JUMPS}")
    print(f"-> {OUT_QUAR}")
    con.close()


if __name__ == "__main__":
    main()
