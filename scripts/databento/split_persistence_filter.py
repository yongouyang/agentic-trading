#!/usr/bin/env python3
"""Close-persistence post-filter for split_candidate_detector.py v3 output.

Same gate as apps/api/src/cli/audit-inband-persistence.ts (2026-09-05):
v3's price signature uses the ex-day OPEN, so a 1-2 session bad open print
(AACT 2023-07-27: open 15.9 vs closes ~10.18; AAMI 2025-01-24: open 16.72
vs closes ~25.4) produces a fake candidate whose CLOSE never leaves the
pre-split level. A genuine split reprices the close permanently (it may
drift afterwards — deep-reverse microcaps slide >25% within days).

Rule, per candidate row (factor k = detector's lattice estimate, the same
prevClose/exOpen convention as v3):
  window = closes of the ex-date session and the next up to 3 tradeable
           sessions (bars are a single continuous series per file; the
           archive has no segment concept, matching the detector's own
           windows)
  prevHits    closes within LOG_TOL_PERSIST of close[t-1] (unadjusted)
  impliedHits closes within LOG_TOL_PERSIST of close[t-1] / k
  REJECT (bad open print) iff prevHits >= 2 AND impliedHits < 2
Candidates whose window has < 2 tradeable closes (symbol ends at the
candidate date) pass through unchanged — nothing to test against.

Reads the existing v3 CSV and re-opens only the archive files for symbols
that have candidates (no full re-scan). Writes detected-split-candidates-v4.csv.

Usage: python3 split_persistence_filter.py [--dir ~/Downloads/XNAS-...] \
         [--in detected-split-candidates-v3.csv] [--out ...v4.csv]
Requires: pip install zstandard
"""
import argparse
import csv
import io
import math
import os

import zstandard as zstd

from split_candidate_detector import symbol_from_filename

LOG_TOL_PERSIST = math.log(1.25)  # audit corroboration tolerance
LOOKAHEAD = 3
MIN_HITS = 2


def load_closes(path):
    """(date, close|None) series from one archive file."""
    rows = []
    dctx = zstd.ZstdDecompressor()
    with open(path, "rb") as fh, dctx.stream_reader(fh) as zr:
        for i, line in enumerate(io.TextIOWrapper(zr, encoding="utf-8")):
            if i == 0:
                continue
            p = line.rstrip("\n").split(",")
            rows.append((p[0][:10], float(p[7]) if p[7] else None))
    return rows


def passes_persistence(closes, ex_date, k):
    """True = keep candidate. closes: [(date, close|None)] sorted by date."""
    tradeable = [r for r in closes if r[1] is not None]
    dates = [d for d, _ in tradeable]
    if ex_date not in dates:
        return True  # ex-date bar missing (halt?) — nothing to test
    t = dates.index(ex_date)
    if t == 0:
        return True
    prev_close = tradeable[t - 1][1]
    if prev_close <= 0:
        return True
    window = [c for _, c in tradeable[t:t + 1 + LOOKAHEAD]]
    if len(window) < MIN_HITS:
        return True
    implied = prev_close / k
    prev_hits = sum(1 for c in window if abs(math.log(c / prev_close)) <= LOG_TOL_PERSIST)
    implied_hits = sum(1 for c in window if abs(math.log(c / implied)) <= LOG_TOL_PERSIST)
    return not (prev_hits >= MIN_HITS and implied_hits < MIN_HITS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.path.expanduser("~/Downloads/XNAS-20260902-W559N3FC8U"))
    ap.add_argument("--in", dest="in_path", default=None)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                  "detected-split-candidates-v4.csv"))
    args = ap.parse_args()
    in_path = args.in_path or os.path.join(args.dir, "detected-split-candidates-v3.csv")

    with open(in_path) as fh:
        rd = csv.reader(fh)
        header = next(rd)
        rows = list(rd)
    k_idx = header.index("factor")

    # filename per symbol (same archive layout the detector scans)
    file_by_symbol = {}
    for fn in os.listdir(args.dir):
        if not fn.endswith(".csv.zst"):
            continue
        sym = symbol_from_filename(fn)
        if sym is not None:
            file_by_symbol[sym] = os.path.join(args.dir, fn)

    kept, rejected, skipped = [], [], 0
    closes_cache = {}
    for r in rows:
        sym, ex_date = r[0], r[1]
        path = file_by_symbol.get(sym)
        if path is None:
            skipped += 1
            kept.append(r)
            continue
        if sym not in closes_cache:
            closes_cache[sym] = load_closes(path)
        if passes_persistence(closes_cache[sym], ex_date, float(r[k_idx])):
            kept.append(r)
        else:
            rejected.append(r)

    with open(args.out, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        w.writerows(kept)
    print(f"v3 candidates: {len(rows)}")
    print(f"rejected as bad-open-print: {len(rejected)}")
    print(f"kept (v4): {len(kept)} -> {args.out}")
    if skipped:
        print(f"note: {skipped} rows had no archive file for their symbol (kept)")
    for r in rejected[:15]:
        print("REJECT", ",".join(r))


if __name__ == "__main__":
    main()
