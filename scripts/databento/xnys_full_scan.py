#!/usr/bin/env python3
"""XNYS archive checks 3-5 in a single streamed pass over all per-day files.

Collects, per file: row count, date-in-row vs filename mismatch, duplicate
(symbol,date) within file; per row: OHLC sanity violations (high<low,
open/close outside [low,high], zero/negative price, zero volume, empty
fields); per symbol: full (date, open, close, volume) series + instrument_id
set, dumped to a pickle in /tmp for downstream analysis (split detection,
registry cross-check).

Read-only on the archive. Outputs: /tmp/xnys-series.pkl + printed stats.
Run with the databento venv python (needs zstandard).
"""
import io
import json
import math
import os
import pickle
import re
import sys
from array import array
from collections import Counter, defaultdict

import zstandard as zstd

DIR = os.path.expanduser("~/Downloads/XNYS-20260903-GYR7NW7XTP")
PICKLE = "/tmp/xnys-series.pkl"
MAX_EXAMPLES = 8
FNAME_RE = re.compile(r"^xnys-pillar-(\d{8})\.ohlcv-1d\.csv\.zst$")

sanity = Counter()
examples = defaultdict(list)
rows_per_day = {}
date_mismatch = 0
dup_symbol_date = 0
empty_field_rows = 0
total_rows = 0
bad_rtype = Counter()
bad_publisher = Counter()

# symbol -> {"dates": [...], "o": array, "c": array, "v": array,
#            "h": array, "l": array, "iids": set}
series = {}
sym_count = Counter()  # rows per symbol


def ex(key, *vals):
    if len(examples[key]) < MAX_EXAMPLES:
        examples[key].append(vals)


files = sorted(f for f in os.listdir(DIR) if FNAME_RE.match(f))
print(f"scanning {len(files)} files...", flush=True)
dctx = zstd.ZstdDecompressor()
for fi, fn in enumerate(files):
    fdate = f"{fn[12:16]}-{fn[16:18]}-{fn[18:20]}"
    path = os.path.join(DIR, fn)
    seen_syms = set()
    nrows = 0
    with open(path, "rb") as fh, dctx.stream_reader(fh) as zr:
        for i, line in enumerate(io.TextIOWrapper(zr, encoding="utf-8")):
            if i == 0:
                continue
            p = line.rstrip("\n").split(",")
            nrows += 1
            total_rows += 1
            d = p[0][:10]
            if d != fdate:
                date_mismatch += 1
                ex("date_mismatch", fn, p[0], p[9] if len(p) > 9 else "?")
            if p[1] != "35":
                bad_rtype[p[1]] += 1
            if p[2] != "9":
                bad_publisher[p[2]] += 1
            sym = p[9] if len(p) > 9 else ""
            if sym in seen_syms:
                dup_symbol_date += 1
                ex("dup_symbol_date", fn, sym)
            seen_syms.add(sym)
            sym_count[sym] += 1
            o, h, l, c, v = p[4], p[5], p[6], p[7], p[8]
            if not (o and h and l and c and v):
                empty_field_rows += 1
                ex("empty_fields", fn, sym, line.rstrip()[:120])
                o = h = l = c = v = math.nan
            else:
                o, h, l, c, v = float(o), float(h), float(l), float(c), float(v)
                if h < l:
                    sanity["high_lt_low"] += 1
                    ex("high_lt_low", d, sym, o, h, l, c, v)
                for name, px in (("open", o), ("close", c)):
                    if px < l - 1e-9 or px > h + 1e-9:
                        sanity[f"{name}_outside_low_high"] += 1
                        ex(f"{name}_outside_low_high", d, sym, o, h, l, c, v)
                if o <= 0 or h <= 0 or l <= 0 or c <= 0:
                    sanity["nonpositive_price"] += 1
                    ex("nonpositive_price", d, sym, o, h, l, c, v)
                if v <= 0:
                    sanity["zero_or_neg_volume"] += 1
                    ex("zero_or_neg_volume", d, sym, o, h, l, c, v)
            s = series.get(sym)
            if s is None:
                s = series[sym] = {"dates": [], "o": array("d"), "h": array("d"),
                                   "l": array("d"), "c": array("d"), "v": array("d"),
                                   "iids": set()}
            s["dates"].append(d)
            s["o"].append(o)
            s["h"].append(h)
            s["l"].append(l)
            s["c"].append(c)
            s["v"].append(v)
            s["iids"].add(p[3])
    rows_per_day[fdate] = nrows
    if (fi + 1) % 250 == 0:
        print(f"  ...{fi + 1}/{len(files)} files, {total_rows:,} rows", flush=True)

print(f"\ntotal data rows: {total_rows:,}")
print(f"distinct symbols: {len(series):,}")
print(f"empty-field rows (no-trade sessions): {empty_field_rows:,}")
print(f"date_mismatch rows: {date_mismatch}")
print(f"duplicate (symbol,date): {dup_symbol_date}")
print(f"non-35 rtype: {dict(bad_rtype)}")
print(f"non-9 publisher_id: {dict(bad_publisher)}")
print("\nsanity violations:")
for k, n in sanity.items():
    print(f"  {k}: {n:,}")
print("\nexamples:")
for k, vals in examples.items():
    print(f"  {k}:")
    for v in vals:
        print("   ", v)

rpd = sorted(rows_per_day.items())
counts = sorted(rows_per_day.values())
n = len(counts)
print(f"\nrows/day: min={counts[0]} p25={counts[n//4]} median={counts[n//2]} "
      f"p75={counts[3*n//4]} max={counts[-1]}")
med = counts[n // 2]
anomalous = [(d, c) for d, c in rpd if c < med * 0.5 or c > med * 2]
print(f"anomalous days (outside 0.5x-2x median {med}): {len(anomalous)}")
for d, c in anomalous[:25]:
    print(f"  {d}: {c}")
print("\nfirst/last days:", rpd[0], rpd[-1])

with open(PICKLE, "wb") as fh:
    pickle.dump({"series": series, "rows_per_day": rows_per_day}, fh,
                protocol=4)
print(f"\nseries pickle -> {PICKLE} ({os.path.getsize(PICKLE)/1e6:.0f} MB)")
