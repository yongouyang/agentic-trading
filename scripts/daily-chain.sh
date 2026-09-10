#!/bin/bash
# Daily chain (locked 2026-09-06): screen:daily then screen:deep-dive for one
# lane, sequentially — no race between the deterministic gate and the LLM leg.
# Invoked by launchd (scripts/launchd/*.plist); logs via launchd
# StandardOutPath to logs/.
#
#   scripts/daily-chain.sh hk|us
#
# The deep-dive leg is preceded by a cheap auth preflight — better to skip
# the deep-dive loudly than fail 20 names × 7 calls. Key source: LLM_API_KEY
# from .env (Moonshot platform, durable) if set, else the Kimi CLI's ROTATING
# OAuth token (a 401 then means: run any `kimi` command to refresh, then
# rerun manually).
set -u
LANE="${1:?usage: daily-chain.sh hk|us}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# launchd runs with a bare PATH (/usr/bin:/bin:...) — make pnpm and node
# (nvm) visible. Failed run 2026-09-10: `pnpm: command not found`.
export PATH="$HOME/Library/pnpm/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  NODE_BIN=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -t. -k1.2n -k2n -k3n | tail -1)
  [ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
fi

echo "== daily-chain $LANE $(date '+%Y-%m-%d %H:%M:%S %Z') =="

pnpm -C apps/api screen:daily -- --market "$LANE"
SCREEN_RC=$?
echo "screen:daily exit=$SCREEN_RC"

# --- LLM auth preflight ---
# Static key first (durable fix 2026-09-09: Moonshot platform key in .env —
# same precedence as resolveApiKey in cli/deep-dive.ts and chat-config.ts);
# fall back to the rotating Kimi CLI OAuth token + coding endpoint.
ENV_KEY=$(grep -E '^LLM_API_KEY=.+' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2-)
if [ -n "$ENV_KEY" ]; then
  TOKEN="$ENV_KEY"
  BASE_URL=$(grep -E '^LLM_BASE_URL=' "$ROOT/.env" | head -1 | cut -d= -f2-)
  HINT="check LLM_API_KEY in .env"
else
  TOKEN=$(node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.kimi-code/credentials/kimi-code.json','utf8')).access_token)}catch(e){process.exit(1)}" 2>/dev/null)
  BASE_URL="https://api.kimi.com/coding/v1"
  HINT="run any kimi command to refresh the token"
fi
if [ -z "$TOKEN" ]; then
  echo "PREFLIGHT FAIL: no LLM key (LLM_API_KEY in .env or Kimi CLI OAuth token) — skipping deep-dive ($HINT)"
  exit "$SCREEN_RC"
fi
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -m 30 "$BASE_URL/chat/completions" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"k3-256k","messages":[{"role":"user","content":"OK"}],"max_tokens":1,"temperature":1,"reasoning_effort":"low"}')
if [ "$HTTP" != "200" ]; then
  echo "PREFLIGHT FAIL: llm auth probe http=$HTTP — skipping deep-dive ($HINT, then rerun: pnpm -C apps/api screen:deep-dive -- --market $LANE --top 10)"
  exit "$SCREEN_RC"
fi

pnpm -C apps/api screen:deep-dive -- --market "$LANE" --top 10
DD_RC=$?
echo "screen:deep-dive exit=$DD_RC"
exit $(( SCREEN_RC != 0 ? SCREEN_RC : DD_RC ))
