#!/bin/bash
#
# Removes the BestQ monitoring agent from this Mac.
#
# Covers both install shapes, because both exist in the wild:
#   /usr/local/bestq                        — what the .pkg installs (needs sudo)
#   ~/Library/Application Support/BestQ     — a per-user install
# An earlier version of this script only knew about the first, so a per-user
# install was left running with its manifest deleted: the browser stopped
# finding it, which looks like a successful uninstall, while the binary and its
# Screen Recording grant stayed on the machine.
#
# What this cannot remove is the TCC entries in System Settings. Only the user
# can, through the GUI — `tccutil reset` is per-bundle-id and this is a plain
# executable, so the only alternative would be resetting Screen Recording for
# every application on the machine. Instructions are printed instead.
set -uo pipefail

HOST_NAME="com.bestq.monitoring"
SUPPORT="${HOME}/Library/Application Support"
USER_INSTALL="${SUPPORT}/BestQ"
SYSTEM_INSTALL="/usr/local/bestq"

removed_any=0

# 1. Stop it first. Deleting a running agent's files leaves it serving the
#    browser from an open file handle until the port closes.
if pgrep -f "bestq-monitoring-agent" >/dev/null 2>&1; then
  pkill -f "bestq-monitoring-agent" 2>/dev/null || true
  echo "  stopped the running agent"
  sleep 1
fi

# 2. Unregister from every browser. This is what actually stops the browser
#    launching it, so it goes before the binaries.
for parent in \
  "${SUPPORT}/Google/Chrome" "${SUPPORT}/Google/Chrome Beta" "${SUPPORT}/Google/Chrome Canary" \
  "${SUPPORT}/Chromium" "${SUPPORT}/BraveSoftware/Brave-Browser" "${SUPPORT}/Microsoft Edge"; do
  manifest="${parent}/NativeMessagingHosts/${HOST_NAME}.json"
  if [ -f "$manifest" ]; then
    rm -f "$manifest" && echo "  unregistered: ${parent##*/Application Support/}"
    removed_any=1
  fi
done

# 3. The login item that re-registers the host for new browser profiles.
PLIST="${HOME}/Library/LaunchAgents/${HOST_NAME}.register.plist"
if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST" && echo "  removed the login item"
  removed_any=1
fi

# 4. Per-user install.
if [ -d "$USER_INSTALL" ]; then
  rm -rf "$USER_INSTALL" && echo "  removed ${USER_INSTALL}"
  removed_any=1
fi

# 5. System install. sudo is asked for ONLY when there is something there, so a
#    per-user uninstall never prompts for a password it does not need.
if [ -d "$SYSTEM_INSTALL" ]; then
  echo "  ${SYSTEM_INSTALL} needs administrator rights to remove"
  sudo rm -rf "$SYSTEM_INSTALL" && echo "  removed ${SYSTEM_INSTALL}"
  sudo pkgutil --forget com.bestq.monitoring.agent >/dev/null 2>&1 || true
  removed_any=1
fi

echo
if [ "$removed_any" -eq 0 ]; then
  echo "Nothing to remove — the agent is not installed for this user."
else
  echo "BestQ monitoring agent removed."
fi

cat <<'NOTE'

Two things this script cannot do for you:

  1. Quit and reopen your browser. Until you do, it may still hold a port to
     the agent it launched earlier.

  2. Remove the permission entries. Open
       System Settings > Privacy & Security > Screen Recording
       System Settings > Privacy & Security > Accessibility
     and remove "bestq-monitoring-agent" from both with the "-" button.
     Leaving them costs nothing functionally, but they are stale grants and
     they will not match a future reinstall's signature anyway.
NOTE
