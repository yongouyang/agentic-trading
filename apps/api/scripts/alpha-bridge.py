#!/usr/bin/env python3
"""
Phase 6A A3 — alpha bridge (docs/phase-6a-plan.md).

    panel CSVs (A2)  ──►  Registry.compute(alpha, panel)  ──►  one date x symbol
                                                               CSV per alpha
                                                               + bridge-manifest.json

**The architectural rule this file exists to enforce.** Their code produces
signals; ours produces returns, statistics and verdicts. This bridge may compute a
factor panel and nothing else — never a return, an IC, a Sharpe or a t-stat. The
deciding number stays single-source in `packages/quant-core/src/ic.ts`. Concretely:
every output here is a `date x symbol` matrix whose shape is asserted equal to the
panel's, so there is no channel through which a statistic could travel.

Formulas are borrowed VERBATIM (`Registry.compute` lazy-imports the zoo module and
calls its own `compute`); nothing in this repo reimplements an alpha. That is the
whole reason the bridge is Python.

Failure isolation is the zoo's, deliberately: `SkipAlpha` (a declared precondition
is unmet — a missing column or sector tag) and `RegistryError` (import or compute
failed, or the output failed the zoo's own sanity checks) are both caught, recorded
in the manifest with their reason, and the run continues. One bad alpha out of 218
must not cost the sweep.

Run it with the pinned dev venv (see docs/phase-6a-plan.md A1 and
`requirements-alpha-bridge.txt`):

    PYTHONPATH=~/vendor/Vibe-Trading/agent \\
      .tools/venv/bin/python apps/api/scripts/alpha-bridge.py --panel <panel dir>

Self-check (builds a broken zoo and asserts the skip paths):
    ... alpha-bridge.selftest.py
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

from src.factors.registry import Registry, RegistryError, SkipAlpha

BRIDGE_VERSION = "6a-a3.1"
PANEL_FIELDS = ("close", "open", "high", "low", "volume")
SIGNALS_DIRNAME = "signals"
MANIFEST_NAME = "bridge-manifest.json"
_OHLCV = {"open", "high", "low", "close", "volume"}


# ---------------------------------------------------------------------------
# io helpers
# ---------------------------------------------------------------------------

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_if_changed(path: Path, text: str) -> bool:
    """Write only when the bytes differ. Returns True when something was written.

    This is what makes the re-run a no-op in the strong sense: identical inputs
    leave the whole output directory untouched, mtimes included, so 'nothing was
    written' is evidence rather than a formatting coincidence.
    """
    data = text.encode("utf-8")
    try:
        if path.read_bytes() == data:
            return False
    except FileNotFoundError:
        pass
    path.write_bytes(data)
    return True


def zoo_digest(root: Path) -> tuple[str, int, int]:
    """Content digest of every `.py` under the zoo root.

    Preferred over a git revision as the *primary* provenance: it names the exact
    formula bytes that ran, and it works for any zoo root, including a test
    fixture that is not a git checkout.
    """
    h = hashlib.sha256()
    files = 0
    total = 0
    for p in sorted(root.rglob("*.py")):
        rel = p.relative_to(root).as_posix()
        data = p.read_bytes()
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(data)
        h.update(b"\0")
        files += 1
        total += len(data)
    return h.hexdigest(), files, total


def git_revision(root: Path) -> str | None:
    """Best-effort `git rev-parse HEAD`. Local only — no network; failure is fine."""
    for parent in [root, *root.parents]:
        if (parent / ".git").exists():
            try:
                out = subprocess.run(
                    ["git", "-C", str(parent), "rev-parse", "HEAD"],
                    capture_output=True, text=True, timeout=10, check=True,
                )
                return out.stdout.strip()
            except Exception:  # noqa: BLE001 — provenance is optional, never fatal
                return None
    return None


# ---------------------------------------------------------------------------
# panel
# ---------------------------------------------------------------------------

def read_panel(panel_dir: Path) -> tuple[dict[str, pd.DataFrame], dict]:
    manifest_file = panel_dir / "manifest.json"
    if not manifest_file.is_file():
        raise SystemExit(f"FATAL: {manifest_file} not found — run `pnpm -C apps/api panel:export` first")
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))

    panel: dict[str, pd.DataFrame] = {}
    for field in PANEL_FIELDS:
        f = panel_dir / f"{field}.csv"
        if f.is_file():
            panel[field] = pd.read_csv(f, index_col=0)
    if "close" not in panel:
        raise SystemExit(f"FATAL: {panel_dir}/close.csv not found")
    return panel, manifest


def select_alphas(registry: Registry, universe: str | None, requested: list[str] | None,
                  limit: int | None) -> tuple[list[str], dict]:
    """The alpha set: explicitly requested, or every CLEAN alpha for the lane.

    'Clean' is the phase's locked round-1 rule: `columns_required` within OHLCV and
    no sector tag. It is applied here rather than requested by id so a full sweep
    cannot silently drift from the pre-registered definition — the alternative,
    trusting a hand-written list, is how the 218/166 count could quietly change.
    """
    meta_by_id: dict[str, dict] = {}
    zoo_by_id: dict[str, str] = {}
    for z in registry.export_manifest()["zoos"]:
        for e in z["alphas"]:
            meta_by_id[e["id"]] = e["meta"]
            zoo_by_id[e["id"]] = z["zoo_id"]

    eligible = [
        aid for aid in registry.list(universe=universe)
        if set(meta_by_id[aid].get("columns_required", [])) <= _OHLCV
        and not meta_by_id[aid].get("requires_sector")
    ] if universe else sorted(meta_by_id)

    if requested is not None:
        unknown = [a for a in requested if a not in meta_by_id]
        if unknown:
            raise SystemExit(f"FATAL: unknown alpha id(s): {', '.join(unknown)}")
        # An explicit request bypasses the clean filter on purpose: it is how a
        # known-blocked alpha gets probed for its skip reason.
        selected = sorted(dict.fromkeys(requested))
    else:
        selected = eligible

    if limit is not None:
        selected = selected[:limit]
    return selected, {"universe": universe, "cleanEligible": len(eligible),
                      "metaById": meta_by_id, "zooById": zoo_by_id}


# ---------------------------------------------------------------------------
# compute + write
# ---------------------------------------------------------------------------

def align_output(result: pd.DataFrame, ref: pd.DataFrame) -> pd.DataFrame:
    """Reattach the panel's own labels.

    `Registry._validate_output` asserts the shape but not the labels, and a zoo
    module that returns a `reset_index()` frame (or reorders columns) would
    otherwise be written with the wrong date/symbol axis — a silent, plausible
    corruption of exactly the kind this project treats as worse than a crash.
    """
    if list(result.columns) == list(ref.columns) and list(result.index) == list(ref.index):
        return result
    out = result.copy()
    out.index = ref.index
    out.columns = ref.columns
    return out


def serialise(df: pd.DataFrame) -> str:
    """date x symbol CSV, float32, NaN preserved as an empty cell.

    `%.9g` is not decoration: nine significant digits is the round-trip width of
    an IEEE-754 binary32, so the text is exactly the float32 the alpha produced.
    Formatting is fixed because A3's exit criterion is a byte-identical re-run.
    """
    return df.astype("float32").to_csv(float_format="%.9g", na_rep="", index_label="date")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Phase 6A A3 — compute zoo alphas over a panel export")
    ap.add_argument("--panel", required=True, help="panel directory written by `panel:export`")
    ap.add_argument("--alpha", action="append", default=None,
                    help="alpha id(s), comma-separated or repeated; default = every clean alpha for the lane")
    ap.add_argument("--limit", type=int, default=None, help="cap the alpha set (smoke runs)")
    ap.add_argument("--zoo-root", default=None, help="override the zoo directory (tests use this)")
    ap.add_argument("--json", action="store_true", help="print the manifest instead of a summary")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    log = (lambda *a: None) if args.quiet else (lambda *a: print(*a, file=sys.stderr))

    panel_dir = Path(args.panel).resolve()
    t0 = time.time()
    panel, panel_manifest = read_panel(panel_dir)
    symbol_count = panel["close"].shape[1]
    row_count = panel["close"].shape[0]
    log(f"  panel {panel_dir.name}: {row_count} sessions x {symbol_count} symbols, "
        f"fields {', '.join(sorted(panel))}")

    market = panel_manifest.get("market")
    universe = {"US": "equity_us", "HK": "equity_hk"}.get(market)
    if universe is None:
        raise SystemExit(f"FATAL: panel manifest has no usable market (got {market!r})")

    zoo_root = Path(args.zoo_root).resolve() if args.zoo_root else None
    registry = Registry(zoo_root=zoo_root)
    # No public accessor for the resolved root; `_zoo_root` is the only way to
    # record WHICH zoo produced these signals, which is the point of the
    # provenance block. Reading it is safer than re-deriving the default here.
    effective_zoo_root: Path = zoo_root or Path(registry._zoo_root)
    health = registry.health()
    if health["loaded"] == 0:
        raise SystemExit("FATAL: registry loaded 0 alphas — wrong --zoo-root?")
    log(f"  zoo: {health['loaded']} alphas loaded, {health['failed']} failed to parse")

    requested = None
    if args.alpha:
        requested = [a.strip() for chunk in args.alpha for a in chunk.split(",") if a.strip()]
    selected, sel = select_alphas(registry, universe, requested, args.limit)
    log(f"  alphas: {len(selected)} selected (clean-eligible for {universe}: {sel['cleanEligible']})")

    out_dir = panel_dir / SIGNALS_DIRNAME
    out_dir.mkdir(parents=True, exist_ok=True)

    alphas: list[dict] = []
    skipped: list[dict] = []
    wrote: list[str] = []
    for i, alpha_id in enumerate(selected, 1):
        meta = sel["metaById"][alpha_id]
        entry = {
            "id": alpha_id,
            "zoo": sel["zooById"][alpha_id],
            "columnsRequired": meta.get("columns_required", []),
            "declaredMinWarmupBars": meta.get("min_warmup_bars"),
        }
        started = time.time()
        try:
            result = registry.compute(alpha_id, panel)
        except SkipAlpha as exc:
            skipped.append({**entry, "error": "SkipAlpha", "reason": str(exc)})
            log(f"  [{i}/{len(selected)}] skip {alpha_id}: {exc}")
            continue
        except RegistryError as exc:
            skipped.append({**entry, "error": "RegistryError", "reason": str(exc)})
            log(f"  [{i}/{len(selected)}] skip {alpha_id}: {exc}")
            continue
        except Exception as exc:  # noqa: BLE001 — one alpha must never end the sweep
            skipped.append({**entry, "error": type(exc).__name__, "reason": str(exc)})
            log(f"  [{i}/{len(selected)}] skip {alpha_id}: {type(exc).__name__}: {exc}")
            continue

        result = align_output(result, panel["close"])
        text = serialise(result)
        changed = write_if_changed(out_dir / f"{alpha_id}.csv", text)
        if changed:
            wrote.append(f"{alpha_id}.csv")
        arr = result.to_numpy(dtype=np.float64, na_value=np.nan)
        non_null_by_row = (~np.isnan(arr)).any(axis=1)
        first_row = int(np.argmax(non_null_by_row)) if non_null_by_row.any() else None
        alphas.append({
            **entry,
            "outputFile": f"{SIGNALS_DIRNAME}/{alpha_id}.csv",
            "rows": int(result.shape[0]),
            "symbols": int(result.shape[1]),
            "nonNullCells": int((~np.isnan(arr)).sum()),
            "firstNonNaNRow": first_row,
            "firstNonNaNSession": str(panel["close"].index[first_row]) if first_row is not None else None,
            "outputSha256": sha256_bytes(text.encode("utf-8")),
            "outputBytes": len(text),
            "seconds": round(time.time() - started, 3),
        })

    digest, zoo_files, zoo_bytes = zoo_digest(effective_zoo_root)
    manifest = {
        "bridgeVersion": BRIDGE_VERSION,
        # Preserved across re-runs (below) so a re-run is byte-identical and can be
        # asserted to be a no-op, exactly as the panel manifest does.
        "generatedAt": None,
        "panel": {
            "dir": panel_dir.name,
            "market": market,
            "fingerprint": panel_manifest.get("fingerprint"),
            "panelRange": panel_manifest.get("panelRange"),
            "replayWindow": panel_manifest.get("replayWindow"),
            "rows": row_count,
            "symbols": symbol_count,
        },
        "runtime": {
            "python": sys.version.split()[0],
            "pandas": pd.__version__,
            "numpy": np.__version__,
            "bottleneck": _has_bottleneck(),
        },
        "zoo": {
            "root": str(effective_zoo_root),
            "digest": digest,
            "pyFiles": zoo_files,
            "pyBytes": zoo_bytes,
            "gitRevision": git_revision(effective_zoo_root),
            "loaded": health["loaded"],
            "failed": health["failed"],
        },
        "selection": {
            "universe": universe,
            "cleanEligible": sel["cleanEligible"],
            "explicitRequest": requested is not None,
            "requested": len(selected),
            "evaluated": len(alphas),
            "skipped": len(skipped),
        },
        "alphas": sorted(alphas, key=lambda a: a["id"]),
        "skipped": sorted(skipped, key=lambda s: s["id"]),
        "outputs": {
            "written": sorted(wrote),
            "unchanged": len(selected) - len(skipped) - len(wrote),
            "totalBytes": sum(a["outputBytes"] for a in alphas),
        },
        "limits": [
            "Signals only: a value at T uses panel rows <= T. Any return, IC, t-stat or portfolio result is out of scope here and computed in TypeScript.",
            "The panel's dividend anchor is not point-in-time (phase-6a amendment A2-1); the manifest records its measured size on the panel side.",
            "An alpha skipped here is ABSENT from the sweep, not a zero — A6 must report the skipped set alongside the labels.",
            "Float32 output at %.9g: the text is exactly the binary32 the alpha produced, so a re-run is byte-identical.",
        ],
    }

    manifest_file = out_dir / MANIFEST_NAME
    try:
        prior = json.loads(manifest_file.read_text(encoding="utf-8"))
        if prior.get("generatedAt"):
            manifest["generatedAt"] = prior["generatedAt"]
    except FileNotFoundError:
        pass
    if manifest["generatedAt"] is None:
        manifest["generatedAt"] = _iso_now()

    manifest_changed = write_if_changed(manifest_file, json.dumps(manifest, indent=2) + "\n")
    if manifest_changed:
        wrote.append(MANIFEST_NAME)

    if args.json:
        print(json.dumps(manifest, indent=2))
    else:
        print(summarise(manifest, elapsed=time.time() - t0))
    log(f"  signals → {out_dir}")
    return 0


def _iso_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _has_bottleneck() -> bool:
    try:
        import bottleneck  # noqa: F401
        return True
    except ImportError:
        return False


def summarise(m: dict, elapsed: float) -> str:
    out: list[str] = []
    s = m["selection"]
    out.append(f"== ALPHA BRIDGE {m['bridgeVersion']} ==")
    out.append(f"panel      {m['panel']['dir']} · {m['panel']['market']} · {m['panel']['rows']} sessions x {m['panel']['symbols']} symbols")
    out.append(f"zoo        {m['zoo']['loaded']} loaded · digest {m['zoo']['digest'][:12]} · rev {m['zoo']['gitRevision'] or 'n/a'}")
    out.append(f"runtime    python {m['runtime']['python']} · pandas {m['runtime']['pandas']} · numpy {m['runtime']['numpy']} · bottleneck {m['runtime']['bottleneck']}")
    out.append(f"selection  {s['universe']} · clean-eligible {s['cleanEligible']} · evaluated {s['evaluated']} · skipped {s['skipped']}")
    reasons: dict[str, int] = {}
    for sk in m["skipped"]:
        reasons[sk["error"]] = reasons.get(sk["error"], 0) + 1
    if reasons:
        out.append(f"skips      {', '.join(f'{k} {v}' for k, v in sorted(reasons.items()))}")
        for sk in m["skipped"][:10]:
            out.append(f"           {sk['id']}: {sk['error']}: {sk['reason'][:110]}")
    sizes = [a["outputBytes"] for a in m["alphas"]]
    if sizes:
        out.append(f"output     {m['outputs']['totalBytes'] / 1e6:.1f} MB total · {np.median(sizes) / 1e6:.2f} MB median per alpha")
    out.append(f"files      wrote {len(m['outputs']['written'])}, unchanged {m['outputs']['unchanged']}  ({elapsed:.1f}s)")
    return "\n".join(out)


if __name__ == "__main__":
    sys.exit(main())
