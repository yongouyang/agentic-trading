#!/usr/bin/env bash
# W1c exit-code tests for scripts/daily-chain.sh (docs/ops-hardening-plan.md).
#
# The chain's whole job now is to be non-zero when something went wrong. Before
# 2026-09-10 it returned $SCREEN_RC on a skipped deep-dive, so a run that never
# happened exited 0 and launchd recorded a clean job.
#
# Runs the REAL script against stubbed pnpm/curl. HOME is redirected to a temp
# dir so the script's PATH prepends resolve to nothing and the stub wins, and so
# no real Kimi credentials are picked up. The repo's own .env supplies
# LLM_API_KEY, which is what makes the preflight reachable at all.
#
#   bash scripts/tests/daily-chain.test.sh
set -u

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin" "$TMP/home" "$TMP/logs"

# --- stub pnpm: dispatches on the requested script, exit codes from env ---
cat > "$TMP/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
args="$*"
# Echoed so the tests can assert WHICH legs ran, not just the final code.
echo "STUB pnpm: $args" >&2
case "$args" in
  *screen:daily*)    exit "${STUB_SCREEN_RC:-0}" ;;
  *screen:deep-dive*) exit "${STUB_DD_RC:-0}" ;;
  *ops:health*)      exit "${STUB_HEALTH_RC:-0}" ;;
  *) echo "stub pnpm: unexpected invocation: $args" >&2; exit 99 ;;
esac
STUB
chmod +x "$TMP/bin/pnpm"

# --- stub curl: the LLM preflight probe ---
cat > "$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
echo "${STUB_HTTP:-200}"
STUB
chmod +x "$TMP/bin/curl"

pass=0
fail=0

# run_case <name> <expected-exit> <screen_rc> <dd_rc> <health_rc> [http]
run_case() {
  local name="$1" expected="$2" s="$3" d="$4" h="$5" http="${6:-200}"
  local out rc
  out=$(PATH="$TMP/bin:$PATH" HOME="$TMP/home" \
        STUB_SCREEN_RC="$s" STUB_DD_RC="$d" STUB_HEALTH_RC="$h" STUB_HTTP="$http" \
        bash "$REPO/scripts/daily-chain.sh" us 2>&1)
  rc=$?
  if [ "$rc" = "$expected" ]; then
    pass=$((pass+1)); printf 'ok   %-52s exit=%s\n' "$name" "$rc"
  else
    fail=$((fail+1)); printf 'FAIL %-52s exit=%s (expected %s)\n' "$name" "$rc" "$expected"
    printf '     output: %s\n' "$(echo "$out" | tr '\n' '|')"
  fi
  LAST_OUT="$out"
}

run_case "clean run"                        0 0 0 0
run_case "screen leg failed"                2 2 0 0
run_case "deep-dive leg failed"             4 0 4 0
run_case "deep-dive partial failure is 4 not 0" 4 0 1 0
run_case "post-condition health failed"     5 0 0 1
run_case "auth preflight failed -> 3"       3 0 0 0 500
run_case "highest code wins (health 5 beats dd 4)" 5 0 4 1
run_case "degraded screen is non-zero"     2 2 0 0

# A degraded screen must NOT skip the deep-dive leg (locked gap decision): the
# run is marked degraded and the deep-dive still happens.
if echo "$LAST_OUT" | grep -q "screen:deep-dive"; then
  pass=$((pass+1)); printf 'ok   %-52s\n' "degraded screen still runs the deep-dive leg"
else
  fail=$((fail+1)); printf 'FAIL %-52s\n' "degraded screen still runs the deep-dive leg"
fi

# The preflight skip must never be masked by a successful screen (the original
# silent-failure path).
PATH="$TMP/bin:$PATH" HOME="$TMP/home" STUB_SCREEN_RC=0 STUB_DD_RC=0 STUB_HEALTH_RC=0 STUB_HTTP=500 \
  bash "$REPO/scripts/daily-chain.sh" us >"$TMP/skip.log" 2>&1
skip_rc=$?
if [ "$skip_rc" = "3" ] && grep -q "PREFLIGHT FAIL" "$TMP/skip.log" && ! grep -q "screen:deep-dive exit=" "$TMP/skip.log"; then
  pass=$((pass+1)); printf 'ok   %-52s exit=%s\n' "preflight skip is loud and never runs the leg" "$skip_rc"
else
  fail=$((fail+1)); printf 'FAIL %-52s exit=%s\n' "preflight skip is loud and never runs the leg" "$skip_rc"
fi

# The post-condition must be scoped to the lane being built.
PATH="$TMP/bin:$PATH" HOME="$TMP/home" STUB_SCREEN_RC=0 STUB_DD_RC=0 STUB_HEALTH_RC=0 \
  bash "$REPO/scripts/daily-chain.sh" hk >"$TMP/lane.log" 2>&1
if grep -q "ops:health -- --lane hk" "$TMP/lane.log"; then
  pass=$((pass+1)); printf 'ok   %-52s\n' "post-condition health check is lane-scoped (hk)"
else
  fail=$((fail+1)); printf 'FAIL %-52s\n' "post-condition health check is lane-scoped (hk)"
fi

echo
echo "daily-chain: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
