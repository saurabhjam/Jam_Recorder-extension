#!/bin/bash
#
# Build the Debian package.
#
# Uses `ar` + `tar` directly rather than dpkg-deb so a release can be produced
# from any host, including macOS CI runners where dpkg is not available. The
# resulting archive is a valid .deb — the format is an ar archive of three
# members in a fixed order.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
VERSION="${BESTQ_AGENT_VERSION:-1.0.0}"
ARCH="${1:-amd64}"
EXT_ID="${BESTQ_EXTENSION_ID:-$(python3 -c "import json;print(json.load(open('${ROOT}/config/extension-ids.json'))['production'])")}"

case "$ARCH" in
  amd64) GOARCH=amd64 ;;
  arm64) GOARCH=arm64 ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

BINARY="${ROOT}/build/bestq-monitoring-agent-linux-${GOARCH}"
[ -f "$BINARY" ] || { echo "error: ${BINARY} not found. Run 'make build-linux' first." >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

install -d -m 755 "${STAGE}/opt/bestq"
install -m 755 "$BINARY" "${STAGE}/opt/bestq/bestq-monitoring-agent"

# The host manifest, one copy, symlinked into each browser's directory by
# postinst. `path` is absolute because Chrome executes it directly.
install -d -m 755 "${STAGE}/opt/bestq"
cat > "${STAGE}/opt/bestq/com.bestq.monitoring.json" <<JSON
{
  "name": "com.bestq.monitoring",
  "description": "BestQ Desktop Monitoring Agent",
  "path": "/opt/bestq/bestq-monitoring-agent",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXT_ID}/"
  ]
}
JSON
chmod 644 "${STAGE}/opt/bestq/com.bestq.monitoring.json"

# System-wide native messaging directories. Chrome reads these in addition to
# the per-user ones, so a single package covers every user on the machine and
# nobody has to copy a file into their home directory.
for dir in \
  "etc/opt/chrome/native-messaging-hosts" \
  "etc/chromium/native-messaging-hosts" \
  "etc/opt/edge/native-messaging-hosts" \
  "etc/brave/native-messaging-hosts"; do
  install -d -m 755 "${STAGE}/${dir}"
  install -m 644 "${STAGE}/opt/bestq/com.bestq.monitoring.json" "${STAGE}/${dir}/com.bestq.monitoring.json"
done

install -d -m 755 "${STAGE}/DEBIAN"
cat > "${STAGE}/DEBIAN/control" <<CONTROL
Package: bestq-monitoring-agent
Version: ${VERSION}
Section: utils
Priority: optional
Architecture: ${ARCH}
Maintainer: BestQ <support@best-quality.in>
Depends: xdotool, xprintidle
Description: BestQ desktop monitoring agent
 Reports the OS foreground application and system-wide idle time to the BestQ
 browser extension over Chrome Native Messaging.
 .
 Requires an X11 session. Wayland does not expose the focused window to
 unprivileged clients, so under Wayland the agent reports application tracking
 as unavailable rather than returning incomplete data.
CONTROL

# xdotool/xprintidle are hard Depends rather than Recommends: without them the
# agent has nothing to report, and a package that installs into a
# non-functional state is worse than one that pulls two small tools.

cat > "${STAGE}/DEBIAN/postinst" <<'POSTINST'
#!/bin/sh
set -e
chmod 755 /opt/bestq/bestq-monitoring-agent || true
# Warn once at install time rather than leaving the user to discover it from an
# empty report.
if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
  echo "bestq-monitoring-agent: this is a Wayland session; application tracking will be reported as unavailable." >&2
fi
exit 0
POSTINST
chmod 755 "${STAGE}/DEBIAN/postinst"

cat > "${STAGE}/DEBIAN/prerm" <<'PRERM'
#!/bin/sh
set -e
exit 0
PRERM
chmod 755 "${STAGE}/DEBIAN/prerm"

OUT="${ROOT}/build/bestq-monitoring-agent_${VERSION}_${ARCH}.deb"
WORK="$(mktemp -d)"; trap 'rm -rf "$STAGE" "$WORK"' EXIT

printf '2.0\n' > "${WORK}/debian-binary"
# COPYFILE_DISABLE stops macOS tar writing AppleDouble `._*` resource-fork
# entries beside every file. Without it the package installs a `._postinst`
# next to `postinst` and a `._`-prefixed twin of every payload file onto the
# target system — verified in the first build of this script.
export COPYFILE_DISABLE=1
( cd "$STAGE/DEBIAN" && tar --numeric-owner --owner=0 --group=0 \
    --exclude='._*' -czf "${WORK}/control.tar.gz" . )
( cd "$STAGE" && tar --numeric-owner --owner=0 --group=0 \
    --exclude=./DEBIAN --exclude='._*' -czf "${WORK}/data.tar.gz" . )

# The ar archive is written directly rather than with the host's `ar`.
#
# A .deb must be a GNU-style ar archive of exactly three members, in order,
# with NO symbol table. macOS's BSD `ar` inserts a `__.SYMDEF` member and uses
# the `#1/length` long-name extension, which dpkg rejects outright — the first
# attempt at this produced an archive whose only member was the symbol table.
# Writing the 60-byte headers here is both shorter than working around that and
# byte-for-byte reproducible on any host.
python3 - "$WORK" "$OUT" <<'PYEOF'
import os, sys

work, out = sys.argv[1], sys.argv[2]
members = ['debian-binary', 'control.tar.gz', 'data.tar.gz']

with open(out, 'wb') as archive:
    archive.write(b'!<arch>\n')
    for name in members:
        path = os.path.join(work, name)
        body = open(path, 'rb').read()
        # name(16) mtime(12) uid(6) gid(6) mode(8) size(10) magic(2).
        # mtime/uid/gid are fixed at 0 so the same inputs always produce an
        # identical archive — a release artefact should be reproducible.
        header = (
            name.ljust(16)[:16]
            + '0'.ljust(12)
            + '0'.ljust(6)
            + '0'.ljust(6)
            + '100644'.ljust(8)
            + str(len(body)).ljust(10)
        ).encode('ascii') + b'`\n'
        assert len(header) == 60, len(header)
        archive.write(header)
        archive.write(body)
        # Members are padded to an even offset.
        if len(body) % 2:
            archive.write(b'\n')
PYEOF

shasum -a 256 "$OUT" | tee "${OUT}.sha256"
echo "built $OUT"
