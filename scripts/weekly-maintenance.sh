#!/bin/bash
# Weekly maintenance chain (locked 2026-09-06): one subcommand per launchd job.
#
#   scripts/weekly-maintenance.sh sentinel   # screen:sentinel -- --eastmoney
#   scripts/weekly-maintenance.sh f10        # ca:f10-refresh (HK lane)
#
# Sunday morning HKT: sentinel 08:47, f10 09:17 — the gap keeps the two
# eastmoney hosts (push2his vs datacenter) from being hit back-to-back.
# Logs via launchd StandardOutPath to logs/; diff week-over-week.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# launchd runs with a bare PATH — make pnpm and node (nvm) visible
# (same fix as daily-chain.sh, failed run 2026-09-10).
export PATH="$HOME/Library/pnpm/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  NODE_BIN=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -t. -k1.2n -k2n -k3n | tail -1)
  [ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
fi
echo "== weekly-maintenance ${1:?usage: weekly-maintenance.sh sentinel|f10} $(date '+%Y-%m-%d %H:%M:%S %Z') =="

case "$1" in
  sentinel) pnpm -C apps/api screen:sentinel -- --eastmoney ;;
  f10)      pnpm -C apps/api ca:f10-refresh ;;
  *)        echo "unknown subcommand $1" >&2; exit 2 ;;
esac
RC=$?
echo "$1 exit=$RC"
exit "$RC"
