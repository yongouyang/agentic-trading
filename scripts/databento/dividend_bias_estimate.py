#!/usr/bin/env python3
"""Quantify how much of the vendor benchmark's dividend yield the Yahoo
harvest makes adjustable (feeds the Gate-2 upward-bias disclosure).

Inputs (all artifacts, no DB writes):
  scripts/databento/liquid-survivors.csv        (symbol, vendor_keys)
  scripts/databento/yahoo-dividends-sweep.jsonl (harvest journal)
  apps/api/prisma/dev.db                        (read-only; latest close only)

Method: trailing-12-month harvested dividend per symbol / latest vendor
close = TTM yield; equal-weight mean over symbols with harvest status
"ok" = the adjustable benchmark yield (Gate-2's benchmark is equal-weight).
The 404/failed residual is the unmeasurable remainder, disclosed as an
upper-bound looseness: its true yield is unknown, bounded above by the
covered universe's payer-conditional yield (404s skew to delisted/ADR/
obscure names, so the true figure is almost certainly below it).
"""
import csv
import datetime
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "..", "..", "apps", "api", "prisma", "dev.db")
JOURNAL = os.path.join(HERE, "yahoo-dividends-sweep.jsonl")
SURVIVORS = os.path.join(HERE, "liquid-survivors.csv")
OUT = os.path.join(HERE, "yahoo-dividends-bias-estimate.txt")

sys.path.insert(0, HERE)
from p2p3_from_db import load_liquid  # noqa: E402

END = "2026-09-02"  # archive end (xnys last session)
TTM_START = "2025-09-03"


def main():
    recs = {}
    with open(JOURNAL) as fh:
        for line in fh:
            if line.strip():
                r = json.loads(line)
                recs[r["symbol"]] = r
    vendors = {}
    with open(SURVIVORS) as fh:
        for row in csv.DictReader(fh):
            vendors[row["symbol"]] = row["vendor_keys"]

    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    liquid = load_liquid(con)
    con.close()
    # latest close per symbol: prefer the feed whose series ends later
    last_close = {}
    for (vendor, sym), series in liquid.items():
        d, c = series[-1][0], series[-1][2]
        if sym not in last_close or d > last_close[sym][0]:
            last_close[sym] = (d, c)

    ok = [s for s, r in recs.items() if r["status"] == "ok"]
    payers, nonpayers = [], []
    for s in ok:
        ttm = sum(d["amount"] for d in recs[s].get("dividends", [])
                  if TTM_START <= d["date"] <= END)
        px = last_close.get(s, (None, None))[1]
        if ttm > 0 and px:
            payers.append((s, ttm / px))
        else:
            nonpayers.append(s)
    n_ok = len(ok)
    y_all = sum(y for _, y in payers) / n_ok
    y_payer = sum(y for _, y in payers) / len(payers) if payers else 0.0
    residual = [s for s, r in recs.items() if r["status"] != "ok"]

    lines = [
        "Dividend-harvest bias estimate — vendor equal-weight benchmark",
        f"window: TTM {TTM_START}..{END}, yields vs latest vendor close",
        f"symbols with harvest ok: {n_ok} "
        f"(payers {len(payers)} = {100*len(payers)/n_ok:.1f}%, "
        f"non-payers {len(nonpayers)}), residual not-found/failed: {len(residual)}",
        f"equal-weight TTM yield over ok symbols (non-payers = 0): {100*y_all:.2f}%/yr",
        f"payer-conditional TTM yield: {100*y_payer:.2f}%/yr",
        "",
        "Interpretation for Gate 2: the scoping session estimated the missing",
        "-dividend upward bias at ~1.5%/yr (~6% cumulative over 4y). The",
        f"harvest makes {100*y_all:.2f}%/yr of benchmark yield adjustable on",
        f"{n_ok}/{n_ok+len(residual)} symbols ({100*n_ok/(n_ok+len(residual)):.1f}%",
        "of the universe). The residual's yield is unmeasurable via Yahoo;",
        f"bounded above by the payer-conditional {100*y_payer:.2f}%/yr but",
        "almost certainly far below (404s skew delisted/ADR/obscure).",
        "",
        "Top-20 payers by TTM yield (sanity: expect REITs/mLPs/BDCs):",
    ]
    for s, y in sorted(payers, key=lambda t: -t[1])[:20]:
        lines.append(f"  {s:8s} {100*y:6.2f}%/yr  ({vendors.get(s,'?')})")
    text = "\n".join(lines) + "\n"
    with open(OUT, "w") as fh:
        fh.write(text)
    print(text)


if __name__ == "__main__":
    main()
