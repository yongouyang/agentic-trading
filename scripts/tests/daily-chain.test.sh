#!/usr/bin/env bash
# W1c exit-code tests for scripts/daily-chain.sh (docs/ops-hardening-plan.md).
#
# The chain's whole job is to be non-zero when something went wrong. Since
# 2026-09-19 the chain is ONE leg — screen:daily (ingest + deterministic screen)
# plus the post-condition health check; the deep-dive leg and its LLM preflight
# were removed by user decision (H2-deepdive abandoned, docs/hypothesis-register.json).
#
# Runs the REAL script against a stubbed pnpm. HOME is redirected to a temp
# dir so the script's PATH prepends resolve to nothing and the stub wins.
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
  *ops:health*)      exit "${STUB_HEALTH_RC:-0}" ;;
  *) echo "stub pnpm: unexpected invocation: $args" >&2; exit 99 ;;
esac
STUB
chmod +x "$TMP/bin/pnpm"

pass=0
fail=0

# run_case <name> <expected-exit> <screen_rc> <health_rc>
run_case() {
  local name="$1" expected="$2" s="$3" h="$4"
  local out rc
  out=$(PATH="$TMP/bin:$PATH" HOME="$TMP/home" \
        STUB_SCREEN_RC="$s" STUB_HEALTH_RC="$h" \
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

run_case "clean run"                        0 0 0
run_case "screen leg failed"                2 2 0
run_case "post-condition health failed"     5 0 1
run_case "highest code wins (health 5 beats screen 2)" 5 2 1

# The retired deep-dive leg must stay retired: no EXECUTABLE line may invoke it
# (comments may mention the ad-hoc CLI). Without this guard a future edit could
# silently restart the token spend.
if grep -vE '^[[:space:]]*#' "$REPO/scripts/daily-chain.sh" | grep -q 'screen:deep-dive'; then
  fail=$((fail+1)); printf 'FAIL %-52s\n' "no screen:deep-dive invocation in the chain"
else
  pass=$((pass+1)); printf 'ok   %-52s\n' "no screen:deep-dive invocation in the chain"
fi

# ...and the stub would have failed the run had the leg executed: assert the
# clean run's output contains no deep-dive line either.
run_case "clean run for the output check"     0 0 0
if echo "$LAST_OUT" | grep -q "screen:deep-dive"; then
  fail=$((fail+1)); printf 'FAIL %-52s\n' "the deep-dive leg does not run"
else
  pass=$((pass+1)); printf 'ok   %-52s\n' "the deep-dive leg does not run"
fi

# The post-condition must be scoped to the lane being built.
PATH="$TMP/bin:$PATH" HOME="$TMP/home" STUB_SCREEN_RC=0 STUB_HEALTH_RC=0 \
  bash "$REPO/scripts/daily-chain.sh" hk >"$TMP/lane.log" 2>&1
if grep -q "ops:health -- --lane hk" "$TMP/lane.log"; then
  pass=$((pass+1)); printf 'ok   %-52s\n' "post-condition health check is lane-scoped (hk)"
else
  fail=$((fail+1)); printf 'FAIL %-52s\n' "post-condition health check is lane-scoped (hk)"
fi

echo
echo "daily-chain: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
