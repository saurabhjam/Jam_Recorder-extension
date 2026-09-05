#!/bin/bash
# Re-register the native messaging host for any browser installed since the
# BestQ agent was. Idempotent and silent; run at login by a LaunchAgent so the
# user never has to reinstall BestQ after installing Brave.
set -euo pipefail
HOST_NAME="com.bestq.monitoring"
MANIFEST="/usr/local/bestq/${HOST_NAME}.json"
[ -f "$MANIFEST" ] || exit 0
SUPPORT="${HOME}/Library/Application Support"
for parent in \
  "${SUPPORT}/Google/Chrome" \
  "${SUPPORT}/Google/Chrome Beta" \
  "${SUPPORT}/Google/Chrome Canary" \
  "${SUPPORT}/Chromium" \
  "${SUPPORT}/BraveSoftware/Brave-Browser" \
  "${SUPPORT}/Microsoft Edge"; do
  if [ -d "$parent" ]; then
    mkdir -p "${parent}/NativeMessagingHosts"
    cp -f "$MANIFEST" "${parent}/NativeMessagingHosts/${HOST_NAME}.json"
  fi
done
exit 0
