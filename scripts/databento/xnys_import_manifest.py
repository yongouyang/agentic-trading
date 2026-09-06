#!/usr/bin/env python3
"""XNYS import manifest (Option A): decide the approved symbol universe for
importing the XNYS.PILLAR per-day archive into VendorBar, mirroring the XNAS
importer's classifier.

Inputs (read-only):
  /tmp/xnys-series.pkl            per-symbol (dates, o/h/l/c/v) from xnys_full_scan.py
  apps/api/prisma/dev.db          VendorInstrument (listing reference, dot
                                  notation), VendorBar vendor='databento-xnas'
  ~/Downloads/XNAS-.../           archive filenames (backstop membership)

Classifier: EXACT port of apps/api/src/cli/import-databento.ts isPlain() +
KNOWN_TEST_SYMBOLS, PLUS an explicit exclusion of NYSE space-notation
derivative suffixes (WS/WSA/WSB, U, PR[A-Z], WI, RT, RTWI, WD) — in XNAS
notation these trip isPlain (units '=', warrants '+', preferreds '-'), so
excluding them is the faithful XNAS convention, not a new rule. Share-class
suffixes (`BRK B`, `BF A`, single letters) are NOT excluded: the XNAS
importer imported `BRK.B` as plain (verified in VendorBar), so the XNAS
convention is that share classes are in scope. Reference/XNAS lookups
normalize space -> '.' so share classes line up (`BRK B` -> `BRK.B`).

Approval (Option A):
  (a) normalized symbol in VendorInstrument with listingExchange in
      {NYSE, NYSE Arca, NYSE American}               -> listed-nyse
  (b) normalized symbol absent from the XNAS archive -> xnys-only-backstop
  both -> "both"

Outputs:
  scripts/databento/xnys-import-manifest.csv
  scripts/databento/xnys-new-symbols-for-sweep.txt
"""
import csv
import math
import os
import pickle
import re
import sqlite3
from array import array
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "..", "..", "apps", "api", "prisma", "dev.db")
XNAS_DIR = os.path.expanduser("~/Downloads/XNAS-20260902-W559N3FC8U")
PICKLE = "/tmp/xnys-series.pkl"
OUT_CSV = os.path.join(HERE, "xnys-import-manifest.csv")
OUT_SWEEP = os.path.join(HERE, "xnys-new-symbols-for-sweep.txt")

NYSE_FAMILY = {"NYSE", "NYSE Arca", "NYSE American"}

KNOWN_TEST_SYMBOLS = {
    "ZVZZT", "ZJZZT", "ZWZZT", "ZBZZT", "ZXZZT", "ZVV", "ZZZ", "ZEXIT",
    "ZIEXT", "ZCZZT", "ZXYZ", "ZTEST", "ZBA", "ZVOL",
}
FNAME_RE = re.compile(r"^xnas-itch-\d{8}-\d{8}\.ohlcv-1d\.(.+)\.csv\.zst$")


def is_plain(sym: str) -> bool:
    """Exact port of import-databento.ts isPlain()."""
    if re.search(r"[=#+]$", sym):
        return False
    if "-" in sym:
        return False
    if re.match(r"^[A-Z]{5}$", sym) and sym[-1] in "UWR":
        return False
    return True


DERIV_SUFFIX_RE = re.compile(r" (WS[A-Z]?|U|PR[A-Z]?|WI|RTWI|RT|WD)$")


def norm(sym: str) -> str:
    return sym.replace(" ", ".")


def median(xs):
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def main():
    with open(PICKLE, "rb") as fh:
        series = pickle.load(fh)["series"]
    print(f"XNYS series: {len(series)} symbols", flush=True)

    db = sqlite3.connect(DB)
    listing = dict(db.execute(
        "SELECT symbol, listingExchange FROM VendorInstrument").fetchall())
    xnas_medvol = {}
    for sym, vols in _grouped_volumes(db):
        xnas_medvol[sym] = median(vols)

    xnas_syms = set()
    for fn in os.listdir(XNAS_DIR):
        m = FNAME_RE.match(fn)
        if m:
            xnas_syms.add(m.group(1))
    xnas_norm = {norm(s) for s in xnas_syms}
    print(f"XNAS archive symbols: {len(xnas_syms)} "
          f"(VendorBar median vol for {len(xnas_medvol)})", flush=True)

    # per-symbol stats + classification
    rows = []          # manifest rows (approved only)
    stats = {}         # sym -> (bars, medvol) for volume cross-check
    cls_counts = Counter()
    suffix_plain = Counter()
    rejected_plain = []
    for sym, s in series.items():
        dates, o, c, v = s["dates"], s["o"], s["c"], s["v"]
        tr = [t for t in range(len(dates))
              if not (math.isnan(o[t]) or math.isnan(c[t]) or math.isnan(v[t]))]
        n_bars = len(tr)
        mv = median([v[t] for t in tr]) if tr else 0.0
        stats[sym] = (n_bars, mv)

        if not is_plain(sym) or DERIV_SUFFIX_RE.search(sym):
            cls_counts["non-plain"] += 1
            if " " in sym and is_plain(sym):
                suffix_plain[sym.split(" ", 1)[1]] += 1
            continue
        if sym in KNOWN_TEST_SYMBOLS:
            cls_counts["test"] += 1
            continue
        cls_counts["plain"] += 1
        if " " in sym:
            cls_counts["plain-share-class"] += 1

        nsym = norm(sym)
        exch = listing.get(nsym)
        a = exch in NYSE_FAMILY
        b = nsym not in xnas_norm
        if a and b:
            reason = "both"
        elif a:
            reason = "listed-nyse"
        elif b:
            reason = "xnys-only-backstop"
        else:
            rejected_plain.append(sym)
            continue
        rows.append({
            "symbol": sym,
            "reason": reason,
            "bars": n_bars,
            "first_date": dates[tr[0]] if tr else "",
            "last_date": dates[tr[-1]] if tr else "",
            "median_volume": round(mv, 1),
        })

    rows.sort(key=lambda r: r["symbol"])
    with open(OUT_CSV, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["symbol", "reason", "bars",
                                           "first_date", "last_date",
                                           "median_volume"])
        w.writeheader()
        w.writerows(rows)
    print(f"-> {OUT_CSV} ({len(rows)} rows)")

    reason_counts = Counter(r["reason"] for r in rows)
    total_bars = sum(r["bars"] for r in rows)
    print("\n== classifier port ==")
    for k, n in cls_counts.most_common():
        print(f"  {k}: {n}")
    print(f"  excluded NYSE space derivative suffixes: {sum(suffix_plain.values())}")
    print(f"  suffix breakdown: {suffix_plain.most_common(15)}")
    print(f"\n== approved: {len(rows)} symbols, {total_bars:,} bars ==")
    for k, n in reason_counts.most_common():
        print(f"  {k}: {n}")
    print(f"  rejected plain (in XNAS, not NYSE-listed): {len(rejected_plain)}")

    # backstop sweep file (absent from XNAS): b-only + both, Yahoo format
    sweep = [r["symbol"] for r in rows if r["reason"] != "listed-nyse"]
    yahoo = sorted(s.replace(" ", "-") for s in sweep)
    transformed = [(s, y) for s, y in zip(sorted(sweep), yahoo) if s != y]
    with open(OUT_SWEEP, "w") as fh:
        fh.write("\n".join(yahoo) + "\n")
    print(f"-> {OUT_SWEEP} ({len(yahoo)} symbols; "
          f"{len(transformed)} transformed space->'-': "
          f"{[y for _, y in transformed[:10]]}...)")

    # ---- validation: overlap + median-volume cross-check -------------------
    approved_norm = {norm(r["symbol"]): r["symbol"] for r in rows}
    rejected_norm = {norm(s): s for s in rejected_plain}
    overlap_approved = sorted(set(approved_norm) & xnas_norm)
    overlap_rejected = sorted(set(rejected_norm) & xnas_norm)
    print(f"\n== overlap with XNAS VendorBar/archive symbols ==")
    print(f"  approved symbols also in XNAS archive: {len(overlap_approved)}")
    print(f"  rejected (NASDAQ-listed) in XNAS archive: {len(overlap_rejected)}")

    def ratios(syms_norm, src):
        out = []
        for ns in syms_norm:
            raw = src[ns]
            xnys_mv = stats[raw][1]
            xnas_mv = xnas_medvol.get(ns) or xnas_medvol.get(raw)
            if xnys_mv > 0 and xnas_mv:
                out.append((raw, xnys_mv, xnas_mv, xnys_mv / xnas_mv))
        return out

    ra = ratios(overlap_approved, approved_norm)
    rr = ratios(overlap_rejected, rejected_norm)
    for label, rs in (("approved", ra), ("rejected", rr)):
        if rs:
            rs_r = [x[3] for x in rs]
            print(f"  {label}: n={len(rs)} ratio>2: "
                  f"{sum(1 for x in rs if x[3] > 2)} ratio<0.5: "
                  f"{sum(1 for x in rs if x[3] < 0.5)} "
                  f"median ratio {median(rs_r):.2f}")

    # disagreements: reference says NASDAQ (rejected) but XNYS volume >> XNAS,
    # or approved (NYSE) but XNYS volume << XNAS
    dis = [x for x in rr if x[3] > 2] + [x for x in ra if x[3] < 0.5]
    dis.sort(key=lambda x: -x[1])
    print(f"\n== disagreements ({len(dis)}, capped at 30 by XNYS volume) ==")
    for raw, xnys_mv, xnas_mv, ratio in dis[:30]:
        exch = listing.get(norm(raw))
        side = exch if exch else ("approved:NYSE-family"
                                  if norm(raw) in approved_norm
                                  else "not-in-reference")
        print(f"  {raw:12s} {side:18s} xnys_medvol={xnys_mv:14,.0f} "
              f"xnas_medvol={xnas_mv:14,.0f} ratio={ratio:8.1f}")

    # in reference as NYSE-family but absent from XNYS
    xnys_norm = {norm(s) for s in series}
    missing = sorted(s for s, e in listing.items()
                     if e in NYSE_FAMILY and s not in xnys_norm)
    print(f"\nNYSE-family per reference but absent from XNYS: {len(missing)}")
    print(f"  examples: {missing[:30]}")


def _grouped_volumes(db):
    cur = db.execute(
        "SELECT symbol, volume FROM VendorBar WHERE vendor='databento-xnas' "
        "ORDER BY symbol")
    sym, vols = None, []
    for s, v in cur:
        if s != sym:
            if sym is not None:
                yield sym, vols
            sym, vols = s, []
        vols.append(v)
    if sym is not None:
        yield sym, vols


if __name__ == "__main__":
    main()
