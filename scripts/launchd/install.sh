#!/usr/bin/env bash
# Install the agentic-trading launchd jobs into ~/Library/LaunchAgents.
# Idempotent: boots out any existing copy before bootstrapping.
#
# W5 (docs/ops-hardening-plan.md): this used the deprecated
# `launchctl unload` / `load -w` pair, which did NOT arm the
# StartCalendarInterval streams — no registration is logged at the 2026-09-06
# install (retention confirmed), the first arming only happened on 09-08 20:18
# via an incidental domain event, and exactly one scheduled run fired in four
# days. Now uses bootout/bootstrap/enable and VERIFIES arming, so an
# install that silently leaves nothing watching fails loudly here instead of
# days later.
set -euo pipefail

REPO="/Users/yongouyang/projects/agentic-trading"
SRC="$REPO/scripts/launchd"
DEST="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

LABELS=(
  com.agentic-trading.daily-hk
  com.agentic-trading.daily-us
  com.agentic-trading.weekly-sentinel
  com.agentic-trading.weekly-f10
  com.agentic-trading.ops-health
)

mkdir -p "$REPO/logs" "$DEST"

for label in "${LABELS[@]}"; do
  cp "$SRC/$label.plist" "$DEST/$label.plist"
  # bootout is the modern replacement for `unload`; first install has nothing
  # to boot out, so a failure here is expected and ignored.
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$DEST/$label.plist"
  launchctl enable "$DOMAIN/$label"
  echo "bootstrapped $label"
done

echo "---"
launchctl list | grep agentic-trading || true

echo "---"
# Fail the install if anything is not actually watching (W5).
bash "$SRC/verify.sh"
