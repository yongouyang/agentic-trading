#!/usr/bin/env python3
"""XNYS archive check 7: cross-check the Yahoo/inband SplitEvent registry
(apps/api/prisma/dev.db) against the XNYS bars, on the symbol overlap.

For every SplitEvent whose symbol appears in the XNYS pickle, measure
prevClose/exOpen and prevClose/exClose at the ex-date and score against the
registry factor (same rubric as apps/api audit:inband, close leg decisive):
  corroborated  e <= ln(1.25)
  drifted       e <= 2*ln(1.25)
  not-corroborated otherwise
plus close-persistence classification and structural misses
(ex-date absent from series / no prev bar / archive edge).

Also joins the detector output (xnys-split-candidates.csv) to measure
detector recall on registry events and to list plausible candidates with no
registry event (Yahoo-gap suspects).
"""
import csv
import math
import os
import pickle
import sqlite3
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "..", "..", "apps", "api", "prisma", "dev.db")
PICKLE = "/tmp/xnys-series.pkl"
CAND = os.path.join(HERE, "xnys-split-candidates.csv")
OUT = os.path.join(HERE, "xnys-registry-crosscheck.csv")

TOL = math.log(1.25)


def main():
    with open(PICKLE, "rb") as fh:
        series = pickle.load(fh)["series"]
    db = sqlite3.connect(DB)
    events = db.execute(
        "SELECT symbol, exDate, event, factor, source FROM SplitEvent").fetchall()
    print(f"registry events: {len(events)}")
    reg_symbols = {e[0] for e in events}
    overlap = reg_symbols & set(series)
    print(f"registry symbols: {len(reg_symbols)}, present in XNYS: {len(overlap)}")

    verdicts = Counter()
    rows_out = []
    for sym, ex_date, event, factor, source in sorted(events):
        if sym not in series:
            continue
        s = series[sym]
        dates, O, C = s["dates"], s["o"], s["c"]
        tr = [t for t in range(len(dates)) if O[t] == O[t] and O[t] > 0 and C[t] > 0]
        pos = {dates[t]: t for t in tr}
        t = pos.get(ex_date)
        if t is None:
            verdicts["ex-date-absent"] += 1
            rows_out.append((sym, ex_date, event, factor, source, "ex-date-absent",
                             "", "", ""))
            continue
        ti = tr.index(t)
        if ti == 0:
            verdicts["no-prev-bar"] += 1
            rows_out.append((sym, ex_date, event, factor, source, "no-prev-bar",
                             "", "", ""))
            continue
        tp = tr[ti - 1]
        pc = C[tp]
        m_open = pc / O[t]
        m_close = pc / C[t]
        e = abs(math.log(m_close / factor))
        if e <= TOL:
            v = "corroborated"
        elif e <= 2 * TOL:
            v = "drifted"
        else:
            v = "not-corroborated"
        # persistence: next <=3 closes at implied level
        window = [C[j] for j in tr[ti:ti + 4]]
        implied = pc / factor
        prev_hits = sum(1 for c in window if abs(math.log(c / pc)) <= TOL)
        impl_hits = sum(1 for c in window if abs(math.log(c / implied)) <= TOL)
        persist = ("bad-open-print" if prev_hits >= 2 and impl_hits < 2
                   else "persistent")
        verdicts[v] += 1
        rows_out.append((sym, ex_date, event, round(factor, 6), source, v,
                         round(m_open, 4), round(m_close, 4), persist))

    print("\nverdicts on XNYS-overlap events:")
    for k, n in verdicts.most_common():
        print(f"  {k}: {n}")
    with open(OUT, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["symbol", "ex_date", "event", "factor", "source", "verdict",
                    "measured_open", "measured_close", "persistence"])
        w.writerows(rows_out)
    print(f"-> {OUT}")

    # detector recall vs registry, and registry-missing plausible candidates
    with open(CAND) as fh:
        rd = csv.DictReader(fh)
        cands = list(rd)
    plausible = [c for c in cands
                 if c["persistence"] == "persistent" and int(c["gap_days"]) <= 14]
    reg_keys = {(e[0], e[1]) for e in events}
    overlap_keys = {(e[0], e[1]) for e in events if e[0] in series}
    det_keys = {(c["symbol"], c["ex_date"]) for c in cands}
    det_plaus_keys = {(c["symbol"], c["ex_date"]) for c in plausible}
    detected = overlap_keys & det_keys
    print(f"\nregistry events on XNYS symbols: {len(overlap_keys)}")
    print(f"  detected by in-band detector (any candidate): {len(detected)}"
          f"  recall={len(detected)/max(1,len(overlap_keys)):.1%}")
    missed = sorted(overlap_keys - det_keys)
    print(f"  registry events with NO detector candidate: {len(missed)}")
    new_cands = sorted(det_plaus_keys - reg_keys)
    print(f"plausible detector candidates NOT in registry: {len(new_cands)}")
    for sym, d in new_cands[:20]:
        c = next(c for c in plausible if c["symbol"] == sym and c["ex_date"] == d)
        print(f"   {sym:8s} {d}  k={c['factor']}  r={c['price_ratio']}")


if __name__ == "__main__":
    main()
