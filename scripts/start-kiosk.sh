#!/usr/bin/env bash
set -euo pipefail

URL="${1:-http://127.0.0.1:8080/}"

if command -v chromium >/dev/null 2>&1; then
  CHROMIUM_BIN="$(command -v chromium)"
elif command -v chromium-browser >/dev/null 2>&1; then
  CHROMIUM_BIN="$(command -v chromium-browser)"
else
  echo "Chromium is not installed." >&2
  exit 1
fi

exec "$CHROMIUM_BIN" \
  --kiosk \
  --start-fullscreen \
  --no-first-run \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=Translate,MediaRouter,AutofillServerCommunication \
  --check-for-update-interval=31536000 \
  --disable-component-update \
  --overscroll-history-navigation=0 \
  --noerrdialogs \
  "$URL"
