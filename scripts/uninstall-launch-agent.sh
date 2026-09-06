#!/bin/sh
set -eu

LABEL=com.greenzeta.amazon-wishlist-monitor
DESTINATION="$HOME/Library/LaunchAgents/$LABEL.plist"
USER_ID=$(id -u)

if [ -f "$DESTINATION" ]; then
  launchctl bootout "gui/$USER_ID" "$DESTINATION" 2>/dev/null || true
  rm -f "$DESTINATION"
  echo "Uninstalled $LABEL. Runtime data and browser profile were left in place."
else
  echo "$LABEL is not installed."
fi
