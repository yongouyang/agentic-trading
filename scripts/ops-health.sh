#!/bin/bash
# Ops health runner (W4e, docs/ops-hardening-plan.md). Invoked by launchd
# (scripts/launchd/com.agentic-trading.ops-health.plist); logs via launchd
# StandardOutPath to logs/.
#
#   scripts/ops-health.sh
#
# Read-only. Writes logs/ops-health-<date>.json and exits 1 when a lane or
# weekly job is in ALERT. The user-facing signal is the dashboard banner
# (GET /ops/health) — this job exists so the artifact and log record exist too.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# launchd runs with a bare PATH — make pnpm and node (nvm) visible.
# Same fix as daily-chain.sh (failed run 2026-09-10: `pnpm: command not found`).
export PATH="$HOME/Library/pnpm/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  # sort -V on the version with the leading v stripped — the old field sort
  # (-k1.2n) compared "24" as "4" and would pick v9.x over v24.x.
  NODE_VER=$(ls "$HOME"/.nvm/versions/node 2>/dev/null | sed 's/^v//' | sort -V | tail -1)
  [ -n "$NODE_VER" ] && export PATH="$HOME/.nvm/versions/node/v$NODE_VER/bin:$PATH"
fi

echo "== ops-health $(date '+%Y-%m-%d %H:%M:%S %Z') =="
pnpm -C apps/api ops:health
RC=$?
echo "ops:health exit=$RC"
exit "$RC"
