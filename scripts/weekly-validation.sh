#!/bin/bash
# Weekly validation digest (2026-09-13): runs the two read-only validation
# clocks nobody otherwise runs on a schedule —
#
#   verdict:validate    Phase-5 readiness + the projection watch (measured
#                       per-day IC sd vs the assumed one; >= 1.5x is Phase-5
#                       A3's pre-agreed "re-price the clock" signal)
#   phase4c:accrual     Track-B prospective accrual
#   north-star          the hypothesis register + the North Star metric
#                       (docs/north-star-metric-lock.md). Run LAST, because
#                       unlike the other two it exits NON-ZERO when the
#                       register fails to reconcile — and a broken register
#                       must fail loudly rather than silently report that no
#                       hypothesis is live, which is L2's completion condition.
#
# The two validation CLIs exit 0 by design (they are status readouts, not gates), so
# this job exists to make their output a weekly artifact: full output is appended
# to logs/weekly-validation.log and a machine-readable digest goes to
# logs/validation-digest-<YYYY-MM-DD>.json, which ops:health reads — a digest
# whose sd ratio has crossed 1.5x surfaces as a WARN there, and a missing
# digest past the first due Sunday is an alert. A non-zero exit from either
# CLI is a REAL failure: recorded in the digest and propagated as exit 1.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# launchd runs with a bare PATH — make pnpm and node (nvm) visible
# (same fix as daily-chain.sh, failed run 2026-09-10).
export PATH="$HOME/Library/pnpm/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  # sort -V on the version with the leading v stripped — the old field sort
  # (-k1.2n) compared "24" as "4" and would pick v9.x over v24.x.
  NODE_VER=$(ls "$HOME"/.nvm/versions/node 2>/dev/null | sed 's/^v//' | sort -V | tail -1)
  [ -n "$NODE_VER" ] && export PATH="$HOME/.nvm/versions/node/v$NODE_VER/bin:$PATH"
fi

mkdir -p "$ROOT/logs"
DATE=$(TZ=Asia/Hong_Kong date '+%Y-%m-%d')
LOG="$ROOT/logs/weekly-validation.log"
echo "== weekly-validation $(date '+%Y-%m-%d %H:%M:%S %Z') ==" | tee -a "$LOG"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pnpm -C apps/api verdict:validate -- --json >"$TMP/verdict.out" 2>&1
VRC=$?
cat "$TMP/verdict.out" >>"$LOG"
echo "verdict:validate exit=$VRC" | tee -a "$LOG"

pnpm -C apps/api phase4c:accrual -- --json >"$TMP/accrual.out" 2>&1
ARC=$?
cat "$TMP/accrual.out" >>"$LOG"
echo "phase4c:accrual exit=$ARC" | tee -a "$LOG"

# Run last and tolerate a non-zero exit here so the projection watch above still
# lands in the digest; the failure is recorded and propagated at the end.
pnpm -C apps/api north-star >"$TMP/northstar.out" 2>&1
NRC=$?
cat "$TMP/northstar.out" >>"$LOG"
echo "north-star exit=$NRC" | tee -a "$LOG"

# The digest ops:health reads. If a CLI failed, its output may not be JSON —
# the exit codes are recorded regardless and the sd fields stay null.
VFILE="$TMP/verdict.out" VRC="$VRC" ARC="$ARC" NRC="$NRC" NDIR="$ROOT/apps/api/reports" YDATE="$DATE" OUT="$ROOT/logs/validation-digest-$DATE.json" node <<'EOF'
const { readFileSync, writeFileSync } = require("node:fs");
const pick = (l) =>
  l && typeof l === "object"
    ? {
        labelled: l.labelled ?? null,
        days: l.days ?? null,
        daysNeeded: l.readiness?.daysNeeded ?? null,
        sdDay: l.sdDay ?? null,
        sdTheory: l.sdTheory ?? null,
      }
    : null;
let report = null;
try {
  // pnpm echoes the script command ("$ tsx ...") above the JSON — slice it off.
  const raw = readFileSync(process.env.VFILE, "utf8");
  report = JSON.parse(raw.slice(raw.indexOf("{")));
} catch {
  // a failed verdict:validate leaves non-JSON output; exits below say so
}
let ns = null;
try {
  ns = JSON.parse(readFileSync(`${process.env.NDIR}/north-star-${process.env.YDATE}.json`, "utf8"));
} catch {
  // a broken register exits non-zero and NRC says so; the digest still lands
}
const lanes = {};
for (const l of report?.lanes ?? []) lanes[l.market] = pick(l);
const digest = {
  date: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10),
  verdictValidateExit: Number(process.env.VRC),
  phase4cAccrualExit: Number(process.env.ARC),
  pooled: pick(report?.pooled),
  lanes,
  // The register summary (additive: ops:health picks named keys). `projects` is the
  // North Star metric's project-level reading — the last GATING hypothesis's
  // projected date — and `liveGating` is what L2's completion condition counts.
  northStar: ns
    ? {
        verdict: ns.verdict,
        liveGating: ns.project?.liveGating ?? null,
        projectDate: ns.project?.date ?? null,
        projectWithheld: ns.project?.withheld ?? [],
        complete: ns.project?.complete ?? null,
        classes: ns.classes ?? {},
        broken: (ns.artifacts ?? []).filter((a) => a.state === "BROKEN").map((a) => a.id),
      }
    : null,
};
writeFileSync(process.env.OUT, JSON.stringify(digest, null, 2));
EOF

if [ "$VRC" -ne 0 ] || [ "$ARC" -ne 0 ] || [ "$NRC" -ne 0 ]; then
  echo "weekly-validation FAILED (verdict:validate=$VRC phase4c:accrual=$ARC north-star=$NRC)" | tee -a "$LOG"
  exit 1
fi
echo "weekly-validation ok — logs/validation-digest-$DATE.json" | tee -a "$LOG"
exit 0
