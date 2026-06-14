#!/usr/bin/env bash
# scripts/switch-env.sh — Branch-aware .env switcher
#
# For each app directory, this script:
#   1. Resolves which branch-specific .env file to use
#   2. Creates it if it does not exist yet (copies from the current active .env)
#   3. Replaces .env with a symlink that points at the branch-specific file
#
# BRANCH → ENV FILE MAPPING
#   Branch      Result file              Logic
#   ─────────   ───────────────────────  ────────────────────────────────────────
#   main/master .env                     No symlink — .env is kept as the real file
#   portaldb    .env.portaldb            .env.portaldb already exists → use it
#   v2version   .env.v2version.local     .env.v2version already missing → .local suffix
#   newbranch   .env.newbranch.local     Neither exists → auto-create with .local suffix
#
# DIRECTORIES HANDLED (only those that exist)
#   . (repo root)  apps/backend  apps/dashboard  apps/extension  apps/worker
#
# USAGE
#   bash scripts/switch-env.sh              # auto-detect current git branch
#   bash scripts/switch-env.sh my-branch    # switch for a specific branch
#
# AUTOMATIC ACTIVATION
#   Installed as .git/hooks/post-checkout and .git/hooks/post-merge so this
#   script runs automatically every time you do `git checkout`/`git switch`.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="${1:-$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")}"

# ── Directories that carry per-branch .env files ─────────────────────────────
DIRS=(
  "$ROOT"
  "$ROOT/apps/backend"
  "$ROOT/apps/dashboard"
  "$ROOT/apps/extension"
  "$ROOT/apps/worker"
)

# ── Resolve the env file suffix for a given branch + directory ───────────────
#
# Priority:
#   1. .env.<branch>       exists in dir → suffix = "<branch>"         (e.g. portaldb)
#   2. .env.<branch>.local exists in dir → suffix = "<branch>.local"   (e.g. v2version.local)
#   3. Neither exists                    → suffix = "<branch>.local"   (will be auto-created)
#   4. main / master                     → empty string (no switching)
#
resolve_suffix() {
  local dir="$1" branch="$2"
  local bl
  bl="$(echo "$branch" | tr '[:upper:]' '[:lower:]')"  # lowercase for main/master check

  case "$bl" in
    main|master) echo ""; return ;;
  esac

  if   [ -f "$dir/.env.${branch}" ];       then echo "${branch}"
  elif [ -f "$dir/.env.${branch}.local" ]; then echo "${branch}.local"
  else                                          echo "${branch}.local"   # new branch
  fi
}

# ── Resolve the real file behind a possible symlink ──────────────────────────
real_file() {
  local path="$1"
  if [ -L "$path" ]; then
    local t; t="$(readlink "$path")"
    [[ "$t" == /* ]] || t="$(dirname "$path")/$t"
    echo "$t"
  else
    echo "$path"
  fi
}

# ── Process each directory ────────────────────────────────────────────────────
echo "[switch-env] Branch: $BRANCH"
echo ""

for DIR in "${DIRS[@]}"; do
  [ -d "$DIR" ] || continue

  SUFFIX="$(resolve_suffix "$DIR" "$BRANCH")"
  LABEL="${DIR#"$ROOT/"}"
  [ "$LABEL" = "$ROOT" ] && LABEL="(root)"

  if [ -z "$SUFFIX" ]; then
    echo "  $LABEL: main/master → .env unchanged"
    continue
  fi

  TARGET="$DIR/.env.${SUFFIX}"
  LINK="$DIR/.env"

  # ── Auto-create branch env file from current active .env ─────────────────
  if [ ! -f "$TARGET" ]; then
    SRC="$(real_file "$LINK")"
    if [ -f "$SRC" ]; then
      cp "$SRC" "$TARGET"
      echo "  $LABEL: created .env.${SUFFIX}  (copied from $(basename "$SRC"))"
    else
      echo "  $LABEL: ⚠️  no source env found — skipping"
      continue
    fi
  fi

  # ── Replace .env with a relative symlink ─────────────────────────────────
  if [ -L "$LINK" ]; then
    rm "$LINK"
  elif [ -f "$LINK" ]; then
    mv "$LINK" "${LINK}.bak"
    echo "  $LABEL: backed up .env → .env.bak"
  fi

  (cd "$DIR" && ln -s ".env.${SUFFIX}" ".env")
  echo "  $LABEL: .env → .env.${SUFFIX}"
done

echo ""
echo "[switch-env] Done. Restart your backend / docker compose to pick up the new env."
