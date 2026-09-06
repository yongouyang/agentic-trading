"""XNYS NEAR/echo funnel reproduction (2026-09-06 vetting).

Replays the review funnel over xnys-split-candidates.csv:
  plausible (persistent, gap_days<=14) -> no exact (symbol, exDate) registry
  match -> echo-like (<=14d + 25%-log factor of a registry event) vs
  FAR (>=4x / <=0.25x) vs NEAR, scoped to the imported databento-xnys universe.
Emits xnys-near-tier-candidates.csv + xnys-echo-class-candidates.csv.
Verdicts are recorded in xnys-near-tier-verdicts.csv.
"""
import csv, math, os, sqlite3
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "..", "..", "apps", "api", "prisma", "dev.db")

con = sqlite3.connect(DB)
reg = {}
for sym, d, f in con.execute("SELECT symbol, exDate, factor FROM SplitEvent"):
    reg.setdefault(sym, []).append((d, f))
universe = {r[0] for r in con.execute("SELECT DISTINCT symbol FROM VendorBar WHERE vendor='databento-xnys'")}

def pd(s):
    y,m,dd = s.split("-"); return date(int(y),int(m),int(dd))

LOGT = math.log(1.25)
plausible = []
with open(os.path.join(HERE, "xnys-split-candidates.csv")) as fh:
    for row in csv.DictReader(fh):
        if row["persistence"] == "persistent" and int(row["gap_days"]) <= 14:
            plausible.append(row)

no_exact = [c for c in plausible if not any(c["ex_date"] == rd for rd, _ in reg.get(c["symbol"], []))]
print("plausible:", len(plausible), " no-exact-registry:", len(no_exact))

echo, near_in, far_in, out_uni = [], [], [], 0
for row in no_exact:
    sym, d, f = row["symbol"], row["ex_date"], float(row["factor"])
    cd = pd(d)
    if any(abs((cd - pd(rd)).days) <= 14 and abs(math.log(f) - math.log(rf)) <= LOGT
           for rd, rf in reg.get(sym, [])):
        if sym in universe: echo.append(row)
        continue
    if sym not in universe:
        out_uni += 1; continue
    (far_in if (f >= 4 or f <= 0.25) else near_in).append(row)

print("echo in-universe:", len(echo), " NEAR:", len(near_in), " FAR:", len(far_in), " out-of-universe:", out_uni)
for path, rows in (("os.path.join(HERE, "xnys-near-tier-candidates.csv")", near_in), ("os.path.join(HERE, "xnys-echo-class-candidates.csv")", echo)):
    if rows:
        with open(path, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            w.writeheader(); w.writerows(rows)
