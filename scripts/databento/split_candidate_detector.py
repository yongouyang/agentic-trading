#!/usr/bin/env python3
"""In-band split-candidate detector for the DataBento XNAS ohlcv-1d archive.

Purpose (docs/research-databento-import.md §4.3): a SECOND OPINION against the
Yahoo split registry — catches events Yahoo dropped (measured: TBLT 1:65
reverse split 2024-01-02 exists in ITCH bars but Yahoo returns no event) and
covers delisted names Yahoo 404s. NOT authoritative: share volume does not
scale by exactly 1/k on thin microcaps, so gates are deliberately loose and
output is "candidates" for cross-checking, never auto-adjustment input.

Signature on effective date t (factor k = new shares per old share,
r = close[t-1] / open[t]):
  P1   r ~= a clean rational k (nearest lattice point in log space), with a
       tiered tolerance: NEAR factors (0.5<=k<=4) must match within
       LOG_TOL_NEAR (tight — ordinary ±20% days must not match), FAR factors
       (k<0.5 or k>4, i.e. >=4x overnight repricing) within LOG_TOL_FAR
       (loose — microcap reverse splits gap 3-17% on the ex-date: KTTA 1:20
       opened +17% vs prev_close/20, TENX 1:80 opened -12%).
  P2   volume evidence, also tiered. Empirically volume does NOT scale by k:
       NVDA 10:1 rose only 5.9x, TBLT 1:65 fell only 6.4x, LXEH's 1:10 ADS
       ratio change even rose 8x on the day. So:
       NEAR: v2's strict ratio gates — day volume and 5-session post median
             vs 10-session pre median both within VOL_TOL of k.
       FAR:  direction-only persistence gate — med(vol t+1..t+5) /
             med(vol t-10..t-1) must move the same way as k (share-count
             changes are permanent; crash-volume spikes decay).
  P3   plausibility floors: |k-1| >= MIN_FACTOR_DEV (excludes the whole
       0.7..1.43 factor band — ±30-40% overnight gaps are ordinary
       earnings/biotech moves and the rational lattice is dense enough there
       that ANY such gap matches some rational within LOG_TOL_NEAR, so the
       band is unfixably noisy; measured: 6/6 false positives on a GEOS-heavy
       random sample all had |k-1| in 0.20..0.29), both prices >= MIN_PRICE
       and |open - prev_close| >= MIN_ABS_MOVE (kills sub-dime illiquid
       repricing jitter). Cost: 4:3 / 3:4-class splits are undetectable.

Usage:  python3 split_candidate_detector.py [--dir ~/Downloads/XNAS-...] \
            [--out detected-split-candidates-v2.csv]
Requires: pip install zstandard  (throwaway venv is fine)

History: v1 (single-day volume gate, 35%) missed ALL anchors — NVDA's post-
split volume rose only ~5.7x vs factor 10, KTTA's fell only ~3.4x vs 20 —
while firing 154k false positives on crash-with-volume patterns. v2 added the
persistence gate but was broken three ways: (a) the symbol column p[9] was
dropped from trade rows so the output's symbol column held the DATE
(unjoinable) and no-trade rows put the symbol STRING in the volume slot,
poisoning statistics.median with a TypeError swallowed by the per-file
try/except; (b) the candidate lattice had denominators only 1..10, so every
reverse split deeper than 1:10 (TBLT 1:65, KTTA 1:20, TENX 1:80 — the exact
microcap class this detector exists for) was unmatchable; (c) near-1
rationals (9:10, 10:9, 11:10) matched ordinary ±10% days. v3 (current):
carries the true symbol from the filename (same decode as
yahoo-splits-sweep.mjs), symmetric lattice with numerators/denominators from
1..32 ∪ {40,50,64,65,70,80,100}, MIN_FACTOR_DEV/MIN_PRICE/MIN_ABS_MOVE
floors, and the tiered price/volume gates above. Validated against the
11-event anchor set (NVDA, TSLA, AMZN, GOOGL, SMCI, KTTA, TBLT, TENX x2,
LXEH x2): all detected on the true ex-date; wide-overnight-gap events report
the lattice factor nearest the OBSERVED price ratio (e.g. KTTA reads 3:70 vs
true 1:20 because the stock opened +17% on ex-date) — the factor column is an
estimate from bars, not the registry value. Re-validate anchors after any
gate change.
"""
import argparse
import csv
import io
import math
import os
import re
import statistics
import urllib.parse
from bisect import bisect_left
from fractions import Fraction

import zstandard as zstd

# Price tolerance in log space, tiered by factor extremity (see P1 above).
LOG_TOL_NEAR = 0.025   # 0.5 <= k <= 4: tight, ordinary big days must not match
LOG_TOL_FAR = 0.17     # k < 0.5 or k > 4: loose, microcap ex-dates gap 3-17%
NEAR_LO, NEAR_HI = 0.5, 4.0
VOL_TOL = 0.55         # NEAR tier volume-ratio tolerance (day + persistence)
MIN_FACTOR_DEV = 0.3   # require |k-1| >= this: excludes the noisy 0.7..1.43 band
MIN_PRICE = 0.10       # both close[t-1] and open[t] must be >= $0.10
MIN_ABS_MOVE = 0.05    # |open[t] - close[t-1]| must be >= $0.05

# Split-ratio lattice: real-world ratios are round numbers; symmetric in
# numerator/denominator so deep reverse splits (1:65, 1:80) are matchable.
_BASE = set(range(1, 33)) | {40, 50, 64, 65, 70, 80, 100}
CANDS = sorted({Fraction(n, d)
                for n in _BASE for d in _BASE
                if n != d and 0.01 <= n / d <= 100 and abs(n / d - 1) >= MIN_FACTOR_DEV},
               key=float)
_CAND_FLOATS = [float(f) for f in CANDS]
_CAND_LOGS = [math.log(x) for x in _CAND_FLOATS]

FNAME_RE = re.compile(r"^xnas-itch-\d{8}-\d{8}\.ohlcv-1d\.(.+)\.csv\.zst$")


def symbol_from_filename(fn):
    """Mirror yahoo-splits-sweep.mjs symbolFromFilename (mixed %-encoding)."""
    m = FNAME_RE.match(os.path.basename(fn))
    if not m:
        return None
    try:
        return urllib.parse.unquote(m.group(1))
    except Exception:  # noqa: BLE001
        return m.group(1)


def best_candidate(r):
    """Nearest lattice factor to r in log space, with tiered tolerance."""
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


def process(path):
    symbol = symbol_from_filename(path)
    rows = []
    dctx = zstd.ZstdDecompressor()
    with open(path, "rb") as fh, dctx.stream_reader(fh) as zr:
        for i, line in enumerate(io.TextIOWrapper(zr, encoding="utf-8")):
            if i == 0:
                continue
            p = line.rstrip("\n").split(",")
            # ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol
            if symbol is None and len(p) > 9 and p[9]:
                symbol = p[9]  # fallback: symbol column of the bars
            if not p[4] or not p[7] or not p[8]:
                rows.append((p[0][:10], None, None, None))  # no-trade session
                continue
            rows.append((p[0][:10], float(p[4]), float(p[7]), float(p[8])))
    out = []
    n = len(rows)
    for t in range(1, n):
        d, o, _, v = rows[t]
        c_prev = rows[t - 1][2]
        if (o is None or c_prev is None or c_prev <= 0 or o <= 0
                or not isinstance(v, float)):
            continue
        if c_prev < MIN_PRICE or o < MIN_PRICE or abs(o - c_prev) < MIN_ABS_MOVE:
            continue
        r = c_prev / o
        if 0.72 < r < 1.39:
            continue  # no allowed factor (|k-1| >= MIN_FACTOR_DEV) can match
        f, dev = best_candidate(r)
        if f is None:
            continue
        k = float(f)
        pre = [rows[j][3] for j in range(max(0, t - 10), t)
               if isinstance(rows[j][3], float)]
        post = [rows[j][3] for j in range(t + 1, min(n, t + 6))
                if isinstance(rows[j][3], float)]
        if len(pre) < 3 or len(post) < 3:
            continue
        med_pre = statistics.median(pre)
        if med_pre <= 0:
            continue
        day_ratio = v / med_pre
        persist_ratio = statistics.median(post) / med_pre
        if NEAR_LO <= k <= NEAR_HI:
            # strict ratio gates: volume should scale by ~k, day AND persistent
            if abs(day_ratio / k - 1) > VOL_TOL:
                continue
            if abs(persist_ratio / k - 1) > VOL_TOL:
                continue
        else:
            # direction-only persistence gate (volume does not scale by k on
            # microcap reverse splits / ADS ratio changes — see docstring P2)
            if (persist_ratio - 1) * (k - 1) <= 0:
                continue
        out.append((symbol, d, str(f.numerator), str(f.denominator),
                    round(k, 6), round(r, 6), round(day_ratio, 4),
                    round(persist_ratio, 4), round(dev, 6)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.path.expanduser("~/Downloads/XNAS-20260902-W559N3FC8U"))
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    out_path = args.out or os.path.join(args.dir, "detected-split-candidates-v2.csv")
    files = sorted(f for f in os.listdir(args.dir) if f.endswith(".csv.zst"))
    print(f"scanning {len(files)} files...")
    hits, errors = [], []
    for fn in files:
        try:
            hits.extend(process(os.path.join(args.dir, fn)))
        except Exception as e:  # noqa: BLE001
            errors.append((fn, str(e)))
    hits.sort(key=lambda h: (h[0], h[1]))
    with open(out_path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["symbol", "ex_date", "ratio_new", "ratio_old", "factor",
                    "price_ratio", "vol_gate_day", "vol_gate_persist", "price_dev"])
        w.writerows(hits)
    print(f"{len(hits)} candidates, {len(errors)} error files -> {out_path}")
    for fn, e in errors[:10]:
        print("ERROR", fn, e)


if __name__ == "__main__":
    main()
