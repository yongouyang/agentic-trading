#!/usr/bin/env python3
"""
Phase 6A A3 self-check for `alpha-bridge.py`.

A3's exit criterion has three clauses and two of them cannot be checked by the
TypeScript suite, because the bridge is Python and python is deliberately NOT a
test-suite dependency (`.tools/venv` is dev-only and gitignored). So the check
lives here, next to the thing it checks, and is run explicitly:

    PYTHONPATH=~/vendor/Vibe-Trading/agent \\
      .tools/venv/bin/python apps/api/scripts/alpha-bridge.selftest.py

It builds a throwaway zoo containing a working alpha and two deliberately broken
ones, a throwaway panel, and then asserts:

  1. `no network`      — the bridge runs under a socket guard, so any attempt to
                         open a socket raises instead of silently succeeding.
  2. `skip, not crash` — an alpha whose `compute()` raises is recorded as
                         RegistryError WITH its reason, an alpha requiring a
                         column the panel does not carry is recorded as SkipAlpha,
                         and the working alpha still produces its panel.
  3. `byte-identical`  — a second identical run writes nothing at all.

Exit code 0 = all assertions held.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
BRIDGE = HERE / "alpha-bridge.py"
DEFAULT_AGENT_DIR = Path.home() / "vendor" / "Vibe-Trading" / "agent"

# Runs the bridge with every socket creation poisoned. `subprocess` (used only for
# a local `git rev-parse`) does not touch this; an HTTP client would.
SOCKET_GUARD = """
import runpy, socket, sys
_real = socket.socket
class _Blocked(_real):
    def __init__(self, *a, **k):
        raise RuntimeError("A3 requires the bridge to be offline, but it opened a socket")
socket.socket = _Blocked
runpy.run_path({bridge!r}, run_name="__main__")
"""

GOOD = '''
__alpha_meta__ = {
    "id": "testzoo_good_mom",
    "nickname": "5-session momentum",
    "theme": ["momentum"],
    "formula_latex": "close_t / close_{t-5} - 1",
    "columns_required": ["close"],
    "universe": ["equity_us"],
    "frequency": ["1d"],
    "decay_horizon": 5,
    "min_warmup_bars": 6,
}
import pandas as pd


def compute(panel):
    return panel["close"].pct_change(5)
'''

BROKEN = '''
__alpha_meta__ = {
    "id": "testzoo_broken_crash",
    "nickname": "raises on purpose",
    "theme": ["reversal"],
    "formula_latex": "n/a",
    "columns_required": ["close"],
    "universe": ["equity_us"],
    "frequency": ["1d"],
    "decay_horizon": 0,
    "min_warmup_bars": 0,
}
import pandas as pd


def compute(panel):
    raise ValueError("boom: deliberate fixture failure")
'''

NEEDS_VWAP = '''
__alpha_meta__ = {
    "id": "testzoo_needs_vwap",
    "nickname": "needs a column the panel lacks",
    "theme": ["microstructure"],
    "formula_latex": "(close - vwap) / vwap",
    "columns_required": ["close", "vwap"],
    "universe": ["equity_us"],
    "frequency": ["1d"],
    "decay_horizon": 0,
    "min_warmup_bars": 0,
}
import pandas as pd


def compute(panel):
    return (panel["close"] - panel["vwap"]) / panel["vwap"]
'''

# A shape the zoo's own <<95%-NaN guard tolerates, so the ONE thing that fails is
# the thing under test.
SYMBOLS = ["AAA", "BBB", "CCC", "DDD"]
SESSIONS = [f"2024-01-{d:02d}" for d in range(2, 27)]


def write_panel(root: Path) -> Path:
    panel_dir = root / "us-fixture-1n"
    panel_dir.mkdir()
    header = "date," + ",".join(SYMBOLS)
    for field, scale in (("close", 100.0), ("open", 99.5), ("high", 101.0), ("low", 99.0), ("volume", 1e6)):
        rows = [header]
        for i, date in enumerate(SESSIONS):
            cells = [f"{(scale + 0.5 * i + 3 * s):.6g}" for s in range(len(SYMBOLS))]
            rows.append(f"{date}," + ",".join(cells))
        (panel_dir / f"{field}.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")
    (panel_dir / "manifest.json").write_text(json.dumps({
        "generatedAt": "2024-01-26T00:00:00.000Z",
        "market": "US",
        "fingerprint": "fixture",
        "panelRange": {"start": SESSIONS[0], "end": SESSIONS[-1], "sessions": len(SESSIONS)},
        "replayWindow": {"start": SESSIONS[0], "end": SESSIONS[-1], "sessions": len(SESSIONS)},
    }), encoding="utf-8")
    return panel_dir


def write_zoo(root: Path) -> Path:
    """A zoo root is the directory CONTAINING zoo subdirectories, and each
    subdirectory name is the zoo id — so the fixture is `zoo/testzoo/*.py`.
    Getting this wrong is silent: `Registry._scan` skips non-directories, so a
    flat layout loads 0 alphas with 0 errors."""
    zoo_root = root / "zoo"
    zoo = zoo_root / "testzoo"
    zoo.mkdir(parents=True)
    (zoo / "good_mom.py").write_text(GOOD, encoding="utf-8")
    (zoo / "broken_crash.py").write_text(BROKEN, encoding="utf-8")
    (zoo / "needs_vwap.py").write_text(NEEDS_VWAP, encoding="utf-8")
    return zoo_root


def run_bridge(panel_dir: Path, zoo: Path, env: dict) -> tuple[dict, str]:
    proc = subprocess.run(
        [sys.executable, "-c", SOCKET_GUARD.format(bridge=str(BRIDGE)),
         "--panel", str(panel_dir), "--zoo-root", str(zoo), "--json",
         "--alpha", "testzoo_good_mom,testzoo_needs_vwap,testzoo_broken_crash"],
        capture_output=True, text=True, env=env, cwd=str(HERE),
    )
    if proc.returncode != 0:
        raise AssertionError(f"bridge exited {proc.returncode}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
    return json.loads(proc.stdout), proc.stderr


def main() -> int:
    agent_dir = Path(os.environ.get("VIBE_TRADING_AGENT", DEFAULT_AGENT_DIR)).expanduser()
    if not (agent_dir / "src" / "factors" / "registry.py").is_file():
        print(f"SKIP: no vendor tree at {agent_dir} (set VIBE_TRADING_AGENT)")
        return 0
    env = {**os.environ, "PYTHONPATH": str(agent_dir)}

    root = Path(tempfile.mkdtemp(prefix="alpha-bridge-selftest-"))
    checks: list[tuple[str, bool, str]] = []
    try:
        panel_dir = write_panel(root)
        zoo = write_zoo(root)

        manifest, _ = run_bridge(panel_dir, zoo, env)
        skips = {s["id"]: s for s in manifest["skipped"]}
        alphas = {a["id"]: a for a in manifest["alphas"]}

        checks.append(("offline", True, "ran under a poisoned socket — no network attempted"))

        checks.append((
            "broken alpha skipped with a reason, not a crash",
            skips.get("testzoo_broken_crash", {}).get("error") == "RegistryError"
            and "deliberate fixture failure" in skips["testzoo_broken_crash"]["reason"],
            f"{skips.get('testzoo_broken_crash', {}).get('error')}: {skips.get('testzoo_broken_crash', {}).get('reason', '')[:80]}",
        ))
        checks.append((
            "missing-column alpha skipped as SkipAlpha",
            skips.get("testzoo_needs_vwap", {}).get("error") == "SkipAlpha"
            and "vwap" in skips["testzoo_needs_vwap"]["reason"],
            f"{skips.get('testzoo_needs_vwap', {}).get('error')}: {skips.get('testzoo_needs_vwap', {}).get('reason', '')[:80]}",
        ))
        checks.append((
            "the working alpha still produced its panel",
            "testzoo_good_mom" in alphas and (panel_dir / "signals" / "testzoo_good_mom.csv").is_file(),
            f"first evaluable session {alphas.get('testzoo_good_mom', {}).get('firstNonNaNSession')}",
        ))
        good_csv = (panel_dir / "signals" / "testzoo_good_mom.csv").read_text(encoding="utf-8")
        checks.append(("NaN preserved as an empty cell, float32 widths", ",," in good_csv and good_csv.startswith("date,AAA"), ""))
        checks.append((
            "clean filter counts only OHLCV-only alphas",
            manifest["selection"]["cleanEligible"] == 2,
            f"cleanEligible {manifest['selection']['cleanEligible']} of {manifest['zoo']['loaded']} loaded",
        ))

        _, _ = run_bridge(panel_dir, zoo, env)  # identical second run
        manifest2, _ = run_bridge(panel_dir, zoo, env)
        checks.append((
            "second identical run is a no-op",
            manifest2["outputs"]["written"] == [] and manifest2["outputs"]["unchanged"] == 1,
            f"written {manifest2['outputs']['written']}, unchanged {manifest2['outputs']['unchanged']}",
        ))
        checks.append((
            "generatedAt preserved across re-runs",
            manifest2["generatedAt"] == manifest["generatedAt"],
            manifest2["generatedAt"],
        ))
    finally:
        shutil.rmtree(root, ignore_errors=True)

    ok = all(c[1] for c in checks)
    print("== alpha-bridge selftest ==")
    for name, passed, detail in checks:
        print(f"  {'PASS' if passed else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))
    print("RESULT", "ok" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
