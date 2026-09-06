#!/usr/bin/env bash
# Install the agentic-trading launchd jobs into ~/Library/LaunchAgents.
# Idempotent: unloads any existing copy before loading.
set -euo pipefail

REPO="/Users/yongouyang/projects/agentic-trading"
SRC="$REPO/scripts/launchd"
DEST="$HOME/Library/LaunchAgents"

LABELS=(
  com.agentic-trading.daily-hk
  com.agentic-trading.daily-us
  com.agentic-trading.weekly-sentinel
  com.agentic-trading.weekly-f10
)

mkdir -p "$REPO/logs" "$DEST"

for label in "${LABELS[@]}"; do
  cp "$SRC/$label.plist" "$DEST/$label.plist"
  launchctl unload "$DEST/$label.plist" 2>/dev/null || true
  launchctl load -w "$DEST/$label.plist"
  echo "loaded $label"
done

echo "---"
launchctl list | grep agentic-trading || true
