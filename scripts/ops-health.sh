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
  NODE_BIN=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -t. -k1.2n -k2n -k3n | tail -1)
  [ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
fi

echo "== ops-health $(date '+%Y-%m-%d %H:%M:%S %Z') =="
pnpm -C apps/api ops:health
RC=$?
echo "ops:health exit=$RC"
exit "$RC"
