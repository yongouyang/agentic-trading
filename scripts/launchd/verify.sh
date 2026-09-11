#!/usr/bin/env bash
# Verify the agentic-trading launchd jobs are actually ARMED (W5,
# docs/ops-hardening-plan.md).
#
# Why this exists: on 2026-09-06 install.sh used the deprecated
# `launchctl unload` / `load -w` pair, which left the StartCalendarInterval
# streams unarmed. The logs show NO registration at install time (21:54, with
# retention confirmed present) and the first registration only on 09-08 20:18 —
# so the jobs were armed by later incidental domain events, not by the install.
# In four days exactly one scheduled run fired.
#
# A job that exists but is not watching is invisible: `launchctl list` shows it,
# the plist is valid, and nothing ever runs. This script fails loudly instead.
#
#   bash scripts/launchd/verify.sh          # report + exit 1 if any unarmed
set -u

DOMAIN="gui/$(id -u)"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

LABELS=(
  com.agentic-trading.daily-hk
  com.agentic-trading.daily-us
  com.agentic-trading.weekly-sentinel
  com.agentic-trading.weekly-f10
  com.agentic-trading.daily-catchup
  com.agentic-trading.ops-health
)

fail=0
for label in "${LABELS[@]}"; do
  plist="$HOME/Library/LaunchAgents/$label.plist"
  if [ ! -f "$plist" ]; then
    printf 'MISSING  %-40s not installed\n' "$label"
    fail=1
    continue
  fi

  out=$(launchctl print "$DOMAIN/$label" 2>/dev/null) || {
    printf 'NOTLOAD  %-40s not in %s\n' "$label" "$DOMAIN"
    fail=1
    continue
  }

  # The only evidence that a calendar job will actually fire: the interval
  # stream exists and is watching. Existence alone ("launchctl list" shows the
  # job) is exactly the trap this script was written for.
  watching=$(printf '%s\n' "$out" | grep -A 8 'com\.apple\.launchd\.calendarinterval" = {' | grep -E 'watching = ' | head -1 | tr -d '[:space:]')
  runs=$(printf '%s\n' "$out" | grep -E '^\s*runs = ' | head -1 | tr -d '[:space:]')

  if [ "$watching" = "watching=1" ]; then
    printf 'ARMED    %-40s %s\n' "$label" "${runs:-runs=?}"
  else
    printf 'UNARMED  %-40s calendarinterval %s\n' "$label" "${watching:-absent}"
    fail=1
  fi
done

echo "---"
if [ "$fail" = "0" ]; then
  echo "all ${#LABELS[@]} jobs armed"
else
  echo "ARMING PROBLEM: at least one job will never fire on schedule."
  echo "Re-arm with: bash $REPO/scripts/launchd/install.sh"
fi
exit "$fail"
