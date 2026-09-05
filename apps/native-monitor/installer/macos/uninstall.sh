#!/bin/bash
# Remove the agent and every host manifest it registered.
set -euo pipefail
HOST_NAME="com.bestq.monitoring"
SUPPORT="${HOME}/Library/Application Support"
for parent in \
  "${SUPPORT}/Google/Chrome" "${SUPPORT}/Google/Chrome Beta" "${SUPPORT}/Google/Chrome Canary" \
  "${SUPPORT}/Chromium" "${SUPPORT}/BraveSoftware/Brave-Browser" "${SUPPORT}/Microsoft Edge"; do
  rm -f "${parent}/NativeMessagingHosts/${HOST_NAME}.json" 2>/dev/null || true
done
launchctl unload "${HOME}/Library/LaunchAgents/com.bestq.monitoring.register.plist" 2>/dev/null || true
rm -f "${HOME}/Library/LaunchAgents/com.bestq.monitoring.register.plist"
sudo rm -rf /usr/local/bestq
sudo pkgutil --forget com.bestq.monitoring.agent 2>/dev/null || true
echo "BestQ monitoring agent removed."
