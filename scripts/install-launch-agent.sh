#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
INTERVAL_SECONDS=${1:-3600}
LABEL=com.greenzeta.amazon-wishlist-monitor
TEMPLATE="$PROJECT_DIR/launchd/$LABEL.plist.template"
DESTINATION="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_PATH=$(command -v node || true)
USER_ID=$(id -u)

case "$INTERVAL_SECONDS" in
  ''|*[!0-9]*)
    echo "Interval must be a positive number of seconds." >&2
    exit 2
    ;;
esac

if [ "$INTERVAL_SECONDS" -lt 60 ]; then
  echo "Refusing an interval below 60 seconds." >&2
  exit 2
fi
if [ -z "$NODE_PATH" ]; then
  echo "Node.js was not found on PATH." >&2
  exit 1
fi
if [ ! -f "$PROJECT_DIR/.env" ] || [ ! -f "$PROJECT_DIR/config/lists.json" ]; then
  echo "Create .env and config/lists.json before installing the agent." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT_DIR/logs"
sed \
  -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
  -e "s|__NODE_PATH__|$NODE_PATH|g" \
  -e "s|<integer>3600</integer>|<integer>$INTERVAL_SECONDS</integer>|g" \
  "$TEMPLATE" > "$DESTINATION"
chmod 600 "$DESTINATION"

launchctl bootout "gui/$USER_ID" "$DESTINATION" 2>/dev/null || true
launchctl bootstrap "gui/$USER_ID" "$DESTINATION"
echo "Installed $LABEL with a ${INTERVAL_SECONDS}-second interval."
