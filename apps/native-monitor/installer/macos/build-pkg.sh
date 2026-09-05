#!/bin/bash
#
# Build the macOS installer package.
#
# Produces an unsigned .pkg by default. Signing and notarisation are opt-in via
# environment variables because they need an Apple Developer identity that
# cannot live in a repository — see the README's release section. An unsigned
# package installs fine for internal distribution but Gatekeeper will warn, so
# production releases must set both.
#
#   BESTQ_SIGN_IDENTITY   "Developer ID Installer: Company (TEAMID)"
#   BESTQ_NOTARY_PROFILE  a notarytool keychain profile name
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
VERSION="${BESTQ_AGENT_VERSION:-1.0.0}"
EXT_ID="${BESTQ_EXTENSION_ID:-$(python3 -c "import json;print(json.load(open('${ROOT}/config/extension-ids.json'))['production'])")}"

BUILD="${ROOT}/build"
STAGE="${BUILD}/pkgroot"
OUT="${BUILD}/BestQMonitoringAgent-${VERSION}.pkg"

BINARY="${BUILD}/bestq-monitoring-agent-darwin-universal"
if [ ! -f "$BINARY" ]; then
  echo "error: ${BINARY} not found. Run 'make build-darwin' first." >&2
  exit 1
fi

rm -rf "$STAGE" && mkdir -p "${STAGE}/usr/local/bestq"
install -m 755 "$BINARY" "${STAGE}/usr/local/bestq/bestq-monitoring-agent"
install -m 755 "${HERE}/register-hosts.sh" "${STAGE}/usr/local/bestq/register-hosts.sh"

# The host manifest. `path` is absolute because Chrome executes it directly and
# does not inherit a shell PATH.
cat > "${STAGE}/usr/local/bestq/com.bestq.monitoring.json" <<JSON
{
  "name": "com.bestq.monitoring",
  "description": "BestQ Desktop Monitoring Agent",
  "path": "/usr/local/bestq/bestq-monitoring-agent",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXT_ID}/"
  ]
}
JSON
chmod 644 "${STAGE}/usr/local/bestq/com.bestq.monitoring.json"

# `--install-location /` with an absolute payload: the agent is a system-wide
# binary, while the host manifests it registers are per-user (written by
# postinstall). That split is deliberate — one copy of the binary, registered
# into whichever user installed it.
pkgbuild \
  --root "$STAGE" \
  --scripts "${HERE}/scripts" \
  --identifier "com.bestq.monitoring.agent" \
  --version "$VERSION" \
  --install-location / \
  "${BUILD}/component.pkg"

productbuild \
  --package "${BUILD}/component.pkg" \
  --identifier "com.bestq.monitoring.agent.distribution" \
  --version "$VERSION" \
  "$OUT"

rm -f "${BUILD}/component.pkg"

if [ -n "${BESTQ_SIGN_IDENTITY:-}" ]; then
  echo "signing with ${BESTQ_SIGN_IDENTITY}"
  productsign --sign "$BESTQ_SIGN_IDENTITY" "$OUT" "${OUT}.signed"
  mv "${OUT}.signed" "$OUT"
  if [ -n "${BESTQ_NOTARY_PROFILE:-}" ]; then
    echo "submitting for notarisation"
    xcrun notarytool submit "$OUT" --keychain-profile "$BESTQ_NOTARY_PROFILE" --wait
    xcrun stapler staple "$OUT"
  else
    echo "warning: signed but NOT notarised — Gatekeeper will still warn" >&2
  fi
else
  echo "warning: unsigned package — set BESTQ_SIGN_IDENTITY for a release build" >&2
fi

shasum -a 256 "$OUT" | tee "${OUT}.sha256"
echo "built $OUT"
