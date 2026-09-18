"""Phase 6A A4 — does the REAL zoo peek? The look-ahead invariant on live output.

Runs the bridge twice — once on the full panel, once on a panel truncated at T —
and compares each alpha's output prefix. A trailing-only alpha must agree.

The truncation is done by SLICING THE PANEL CSV TEXT, not by re-exporting a
shorter window from the store. That distinction is the whole test:

  * slicing keeps every surviving row byte-identical, so the truncated panel's
    rows <= T are exactly the full panel's rows <= T, and any disagreement is the
    ALPHA's doing;
  * re-exporting from the store would re-anchor the dividend adjustment at T
    (amendment A2-1), rescaling every row of each symbol by that symbol's
    future-dividend factor — so a perfectly trailing alpha would "fail" for a
    reason that has nothing to do with the alpha.

Run it with the pinned dev venv, next to the bridge:

    PYTHONPATH=~/vendor/Vibe-Trading/agent .tools/venv/bin/python \
      apps/api/scripts/alpha-bridge.prefix-check.py <panel dir> <cut date> <alpha ids>

A4 ran it over 10 alphas spanning all three contributing zoos: **max relative
difference 0.000e+00 over 4,746,606 cells, 0 of 10 peeking** — the zoo is
trailing-only on this evidence, and A6 should widen it to the full 218.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

FIELDS = ("close", "open", "high", "low", "volume", "eligible")
BRIDGE = Path(__file__).resolve().parent / "alpha-bridge.py"
REPO = BRIDGE.parent.parent.parent.parent


def slice_csv(src: Path, dst: Path, cut: str) -> int:
    lines = src.read_text(encoding="utf-8").splitlines()
    header, rows = lines[0], lines[1:]
    kept = [r for r in rows if r.split(",", 1)[0] <= cut]
    dst.write_text("\n".join([header, *kept]) + "\n", encoding="utf-8")
    return len(kept)


def run_bridge(panel: Path, alphas: list[str], env: dict) -> dict:
    proc = subprocess.run(
        [sys.executable, str(BRIDGE), "--panel", str(panel), "--alpha", ",".join(alphas), "--json", "--quiet"],
        capture_output=True, text=True, env=env, cwd=str(REPO),
    )
    if proc.returncode != 0:
        raise SystemExit(f"bridge failed on {panel}: {proc.stderr}")
    return json.loads(proc.stdout)


def parse_csv(path: Path) -> tuple[list[str], dict[str, list[float | None]]]:
    lines = path.read_text(encoding="utf-8").splitlines()
    header = lines[0].split(",")
    rows: dict[str, list[float | None]] = {}
    for line in lines[1:]:
        cells = line.split(",")
        rows[cells[0]] = [None if c == "" else float(c) for c in cells[1:]]
    return header[1:], rows


def main() -> int:
    panel = Path(sys.argv[1]).resolve()
    cut = sys.argv[2]
    alphas = sys.argv[3].split(",")
    agent = os.environ.get("VIBE_TRADING_AGENT", str(Path.home() / "vendor" / "Vibe-Trading" / "agent"))
    env = {**os.environ, "PYTHONPATH": agent}

    tmp = Path(tempfile.mkdtemp(prefix="prefix-check-"))
    trunc = tmp / panel.name
    trunc.mkdir()
    kept = {f: slice_csv(panel / f"{f}.csv", trunc / f"{f}.csv", cut) for f in FIELDS if (panel / f"{f}.csv").is_file()}
    manifest = json.loads((panel / "manifest.json").read_text(encoding="utf-8"))
    manifest["panelRange"] = {"start": manifest["panelRange"]["start"], "end": cut, "sessions": kept["close"]}
    (trunc / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    print(f"full  : {panel.name}  →  truncated at {cut}: {kept['close']} rows (of the full panel's rows)")

    full = run_bridge(panel, alphas, env)
    part = run_bridge(trunc, alphas, env)

    total = 0
    failures = []
    for a in part["alphas"]:
        _, trows = parse_csv(trunc / "signals" / f"{a['id']}.csv")
        _, frows = parse_csv(panel / "signals" / f"{a['id']}.csv")
        worst = 0.0
        worst_at = None
        cells = 0
        for date, tvals in trows.items():
            fvals = frows.get(date)
            if fvals is None:
                raise SystemExit(f"{a['id']}: truncated run has a date {date} the full run lacks")
            for i, (t, f) in enumerate(zip(tvals, fvals)):
                if (t is None) != (f is None):
                    worst = float("inf")
                    worst_at = (date, i, t, f)
                    break
                if t is None:
                    continue
                cells += 1
                rel = abs(t - f) / max(1.0, abs(f))
                if rel > worst:
                    worst, worst_at = rel, (date, i, t, f)
            if worst == float("inf"):
                break
        total += cells
        # Ranks are what the IC reads, so the decision is on VALUES; 1e-9 is the
        # plan's tolerance, and anything a rank could notice is far larger.
        status = "ok  " if worst <= 1e-9 else "PEEK"
        if status == "PEEK":
            failures.append((a["id"], worst, worst_at))
        print(f"  {status} {a['id']:26s} max rel diff {worst:.3e}  over {cells} cells  {'' if worst <= 1e-9 else worst_at}")
    print(f"\ncells compared {total} · peekers {len(failures)} of {len(part['alphas'])} · skipped {len(part['skipped'])}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
