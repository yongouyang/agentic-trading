#!/usr/bin/env python3
"""XNYS archive check 6: in-band split/stitch candidate detection.

Adapts scripts/databento/split_candidate_detector.py v3 gates to the per-day
XNYS shape by regrouping rows per symbol in memory (reads the pickle written
by xnys_full_scan.py). Same P1/P2/P3 gates, PLUS the two post-XNAS lessons
baked in as inline classification:
  (a) close-persistence gate (split_persistence_filter.py rule): over the
      ex-day close + next <=3 tradeable closes, reject as bad-open-print iff
      >=2 closes persist at the PRE-split level and <2 at prevClose/k.
  (b) ticker-reuse / stitch signature: calendar gap between prev bar and
      ex-date > 14 days is reported separately (gap_days column); the XNAS
      NEAR-tier post-mortem showed these are overwhelmingly ticker-reuse
      artifacts, not splits.

Output: scripts/databento/xnys-split-candidates.csv
Columns: symbol, ex_date, ratio_new, ratio_old, factor, price_ratio,
vol_gate_day, vol_gate_persist, price_dev, gap_days, persistence
"""
import csv
import datetime
import math
import os
import pickle
import statistics
from bisect import bisect_left
from fractions import Fraction

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

_BASE = set(range(1, 33)) | {40, 50, 64, 65, 70, 80, 100}
CANDS = sorted({Fraction(n, d)
                for n in _BASE for d in _BASE
                if n != d and 0.01 <= n / d <= 100 and abs(n / d - 1) >= MIN_FACTOR_DEV},
               key=float)
_CAND_FLOATS = [float(f) for f in CANDS]
_CAND_LOGS = [math.log(x) for x in _CAND_FLOATS]

PICKLE = "/tmp/xnys-series.pkl"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "xnys-split-candidates.csv")


def best_candidate(r):
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


def main():
    with open(PICKLE, "rb") as fh:
        series = pickle.load(fh)["series"]
    out = []
    for sym, s in series.items():
        dates, O, C, V = s["dates"], s["o"], s["c"], s["v"]
        n = len(dates)
        # tradeable = rows with real prices (XNYS scan found zero empty rows,
        # but keep the guard for symmetry with the XNAS detector)
        tr = [t for t in range(n) if O[t] == O[t] and O[t] > 0 and C[t] > 0]
        for ti in range(1, len(tr)):
            t, tp = tr[ti], tr[ti - 1]
            o, c_prev, v = O[t], C[tp], V[t]
            if not (v == v):  # NaN volume
                continue
            if c_prev < MIN_PRICE or o < MIN_PRICE or abs(o - c_prev) < MIN_ABS_MOVE:
                continue
            r = c_prev / o
            if 0.72 < r < 1.39:
                continue
            f, dev = best_candidate(r)
            if f is None:
                continue
            k = float(f)
            pre = [V[j] for j in tr[max(0, ti - 10):ti] if V[j] == V[j]]
            post = [V[j] for j in tr[ti + 1:ti + 6] if V[j] == V[j]]
            if len(pre) < 3 or len(post) < 3:
                continue
            med_pre = statistics.median(pre)
            if med_pre <= 0:
                continue
            day_ratio = v / med_pre
            persist_ratio = statistics.median(post) / med_pre
            if NEAR_LO <= k <= NEAR_HI:
                if abs(day_ratio / k - 1) > VOL_TOL:
                    continue
                if abs(persist_ratio / k - 1) > VOL_TOL:
                    continue
            else:
                if (persist_ratio - 1) * (k - 1) <= 0:
                    continue
            # gap days between the two bars
            d0 = datetime.date.fromisoformat(dates[tp])
            d1 = datetime.date.fromisoformat(dates[t])
            gap_days = (d1 - d0).days
            # close-persistence gate
            window = [C[j] for j in tr[ti:ti + 1 + LOOKAHEAD]]
            if len(window) >= MIN_HITS:
                implied = c_prev / k
                prev_hits = sum(1 for c in window
                                if abs(math.log(c / c_prev)) <= LOG_TOL_PERSIST)
                implied_hits = sum(1 for c in window
                                   if abs(math.log(c / implied)) <= LOG_TOL_PERSIST)
                persistence = ("bad-open-print"
                               if prev_hits >= MIN_HITS and implied_hits < MIN_HITS
                               else "persistent")
            else:
                persistence = "untestable"
            out.append((sym, dates[t], f.numerator, f.denominator,
                        round(k, 6), round(r, 6), round(day_ratio, 4),
                        round(persist_ratio, 4), round(dev, 6), gap_days,
                        persistence))
    out.sort(key=lambda h: (h[0], h[1]))
    with open(OUT, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["symbol", "ex_date", "ratio_new", "ratio_old", "factor",
                    "price_ratio", "vol_gate_day", "vol_gate_persist",
                    "price_dev", "gap_days", "persistence"])
        w.writerows(out)
    n = len(out)
    bad_print = sum(1 for h in out if h[10] == "bad-open-print")
    gap = sum(1 for h in out if h[9] > GAP_TICKER_REUSE_DAYS)
    both = sum(1 for h in out if h[9] > GAP_TICKER_REUSE_DAYS and h[10] != "bad-open-print")
    plausible = [h for h in out if h[9] <= GAP_TICKER_REUSE_DAYS and h[10] == "persistent"]
    print(f"candidates: {n}")
    print(f"  rejected by close-persistence (bad open print): {bad_print}")
    print(f"  with calendar gap > {GAP_TICKER_REUSE_DAYS}d (ticker-reuse class): {gap}"
          f" (of which also persistent: {both})")
    print(f"  plausible remainder (gap<=14d, persistent): {len(plausible)}")
    print(f"  untestable persistence: {sum(1 for h in out if h[10]=='untestable')}")
    print(f"-> {OUT}")


if __name__ == "__main__":
    main()
