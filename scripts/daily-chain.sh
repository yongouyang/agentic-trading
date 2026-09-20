#!/bin/bash
# Daily chain: screen:daily for one lane (data ingest + deterministic screen).
# Invoked by launchd (scripts/launchd/*.plist); logs via launchd
# StandardOutPath to logs/.
#
#   scripts/daily-chain.sh hk|us
#
# The deep-dive leg was REMOVED on 2026-09-19 by user decision: H2-deepdive is
# recorded in the hypothesis register as `abandoned` (docs/hypothesis-register.json),
# the nightly list carried no alpha claim (K1), and the leg was the only token
# spend. The screen leg stays: it is free, keeps the store fresh, lets the
# already-accrued verdicts' 20d labels mature, and keeps Track B accruing.
# The deep-dive CLI remains for ad-hoc use:
#   pnpm -C apps/api screen:deep-dive -- --market <lane> [--symbol <ticker>]
#
# Exit codes (W1c, docs/ops-hardening-plan.md):
#   0 clean   2 screen leg failed   5 post-condition health check failed
#   (3 = deep-dive preflight skip and 4 = deep-dive leg failure retired with
#   the leg on 2026-09-19)
# NOTE: a killed process reports nothing itself, which is exactly why the
# post-condition below asks the store what actually got persisted.
set -u
LANE="${1:?usage: daily-chain.sh hk|us}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# launchd runs with a bare PATH (/usr/bin:/bin:...) — make pnpm and node
# (nvm) visible. Failed run 2026-09-10: `pnpm: command not found`.
export PATH="$HOME/Library/pnpm/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  # sort -V on the version with the leading v stripped — the old field sort
  # (-k1.2n) compared "24" as "4" and would pick v9.x over v24.x.
  NODE_VER=$(ls "$HOME"/.nvm/versions/node 2>/dev/null | sed 's/^v//' | sort -V | tail -1)
  [ -n "$NODE_VER" ] && export PATH="$HOME/.nvm/versions/node/v$NODE_VER/bin:$PATH"
fi

echo "== daily-chain $LANE $(date '+%Y-%m-%d %H:%M:%S %Z') =="

pnpm -C apps/api screen:daily -- --market "$LANE"
SCREEN_RC=$?
echo "screen:daily exit=$SCREEN_RC"

# --- post-condition (W1c) ---
# The only check that can see a killed process: ask the store whether a complete
# run exists for this lane. Scoped to the lane so a stale HK lane never fails
# the US chain. The verdict leg of ops:health is silent for sessions screened
# after DEEP_DIVE_RETIRED_AT (2026-09-19), so this check is about the screen leg.
pnpm -C apps/api ops:health -- --lane "$LANE"
HEALTH_RC=$?
echo "ops:health exit=$HEALTH_RC"

RC=0
[ "$SCREEN_RC" -ne 0 ] && RC=2
[ "$HEALTH_RC" -ne 0 ] && RC=5
echo "daily-chain $LANE worst-exit=$RC (screen=$SCREEN_RC health=$HEALTH_RC)"
exit "$RC"
