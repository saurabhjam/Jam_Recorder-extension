#!/usr/bin/env bash
# Copies the branch-specific .env.<variant> files to .env for each app.
# Usage: ./scripts/switch-env.sh [branch-name]
# If branch-name is omitted, uses the current git branch.

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="${1:-$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")}"

# Map branch names → env file suffix (case-insensitive via lowercase)
BRANCH_LOWER="$(echo "$BRANCH" | tr '[:upper:]' '[:lower:]')"
case "$BRANCH_LOWER" in
  v2version)   SUFFIX="v2version.local" ;;
  portaldb)    SUFFIX="portaldb" ;;
  *)           SUFFIX="" ;;
esac

if [ -z "$SUFFIX" ]; then
  echo "[switch-env] No env override for branch '$BRANCH' — keeping existing .env files."
  exit 0
fi

echo "[switch-env] Branch '$BRANCH' → using .env.$SUFFIX"

DIRS=(
  "$ROOT"
  "$ROOT/apps/backend"
  "$ROOT/apps/extension"
  "$ROOT/apps/dashboard"
  "$ROOT/apps/worker"
)

for DIR in "${DIRS[@]}"; do
  SRC="$DIR/.env.$SUFFIX"
  DEST="$DIR/.env"
  if [ -f "$SRC" ]; then
    cp "$SRC" "$DEST"
    echo "  copied $SRC → $DEST"
  else
    echo "  skipped $DIR (no .env.$SUFFIX found)"
  fi
done

echo "[switch-env] Done."
