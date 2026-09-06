#!/bin/bash
# Daily chain (locked 2026-09-06): screen:daily then screen:deep-dive for one
# lane, sequentially — no race between the deterministic gate and the LLM leg.
# Invoked by launchd (scripts/launchd/*.plist); logs via launchd
# StandardOutPath to logs/.
#
#   scripts/daily-chain.sh hk|us
#
# The deep-dive leg is preceded by a cheap auth preflight: the local profile's
# k3-256k credential is the Kimi CLI's ROTATING OAuth token, so an unattended
# run can find it expired — better to skip the deep-dive loudly than fail
# 20 names × 7 calls. A 401 here means: run any `kimi` command to refresh,
# then rerun manually.
set -u
LANE="${1:?usage: daily-chain.sh hk|us}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== daily-chain $LANE $(date '+%Y-%m-%d %H:%M:%S %Z') =="

pnpm -C apps/api screen:daily -- --market "$LANE"
SCREEN_RC=$?
echo "screen:daily exit=$SCREEN_RC"

# --- LLM auth preflight (rotating-token guard) ---
TOKEN=$(node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.kimi-code/credentials/kimi-code.json','utf8')).access_token)}catch(e){process.exit(1)}" 2>/dev/null)
if [ -z "$TOKEN" ]; then
  echo "PREFLIGHT FAIL: no readable Kimi CLI OAuth token — skipping deep-dive (refresh: run any kimi command)"
  exit "$SCREEN_RC"
fi
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -m 30 https://api.kimi.com/coding/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"k3-256k","messages":[{"role":"user","content":"OK"}],"max_tokens":1,"temperature":1,"reasoning_effort":"low"}')
if [ "$HTTP" != "200" ]; then
  echo "PREFLIGHT FAIL: llm auth probe http=$HTTP — skipping deep-dive (run any kimi command to refresh the token, then rerun: pnpm -C apps/api screen:deep-dive -- --market $LANE --top 10)"
  exit "$SCREEN_RC"
fi

pnpm -C apps/api screen:deep-dive -- --market "$LANE" --top 10
DD_RC=$?
echo "screen:deep-dive exit=$DD_RC"
exit $(( SCREEN_RC != 0 ? SCREEN_RC : DD_RC ))
