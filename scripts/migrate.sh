#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# SnapTrace – Database Migration Helper
#
# Usage:
#   chmod +x scripts/migrate.sh
#   ./scripts/migrate.sh <command> [options]
#
# Commands:
#   deploy        Apply all pending migrations (safe, production-ready)
#   dev           Create and apply a new migration in development
#   reset         Reset the database and reapply all migrations (DESTRUCTIVE)
#   status        Show migration status
#   generate      Regenerate Prisma client from schema
#   studio        Open Prisma Studio (GUI database browser)
#
# Examples:
#   ./scripts/migrate.sh deploy
#   ./scripts/migrate.sh dev --name add_recordings_table
#   ./scripts/migrate.sh status
#   ./scripts/migrate.sh reset  # WARNING: destroys all data
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
RESET='\033[0m'

log()     { echo -e "${BLUE}[migrate]${RESET} $*"; }
success() { echo -e "${GREEN}[migrate] $*${RESET}"; }
warn()    { echo -e "${YELLOW}[migrate] WARNING: $*${RESET}"; }
error()   { echo -e "${RED}[migrate] ERROR: $*${RESET}" >&2; exit 1; }

# ── Locate backend directory ───────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"

if [ ! -d "$BACKEND_DIR/prisma" ]; then
  error "Prisma directory not found at $BACKEND_DIR/prisma"
fi

# ── Load environment ──────────────────────────────────────────────────────────
set -a
[ -f "$ROOT_DIR/.env" ] && source "$ROOT_DIR/.env"
[ -f "$BACKEND_DIR/.env" ] && source "$BACKEND_DIR/.env"
set +a

# Verify DATABASE_URL
if [ -z "${DATABASE_URL:-}" ]; then
  error "DATABASE_URL is not set. Check your .env file."
fi

log "Database: ${DATABASE_URL%%@*}@<host>" # Log URL without password
log "Environment: ${NODE_ENV:-development}"

COMMAND="${1:-help}"
shift || true

# ── Prisma runner ─────────────────────────────────────────────────────────────
run_prisma() {
  cd "$BACKEND_DIR"
  if command -v pnpm &>/dev/null && [ -f "package.json" ]; then
    pnpm exec prisma "$@"
  elif command -v npx &>/dev/null; then
    npx --yes prisma "$@"
  else
    error "Neither pnpm nor npx found. Cannot run Prisma."
  fi
}

# ── Commands ──────────────────────────────────────────────────────────────────
case "$COMMAND" in

  deploy)
    log "Applying pending migrations to database..."
    log "This is safe to run in production – it never loses data."
    run_prisma migrate deploy
    success "Migrations deployed successfully."
    ;;

  dev)
    if [ "${NODE_ENV:-}" = "production" ]; then
      error "Cannot run 'migrate dev' in production. Use 'migrate deploy' instead."
    fi
    NAME="${1:-}"
    if [ -n "$NAME" ]; then
      log "Creating and applying migration: $NAME"
      run_prisma migrate dev --name "$NAME"
    else
      log "Creating and applying migration (interactive)..."
      run_prisma migrate dev
    fi
    success "Migration created and applied."
    ;;

  reset)
    if [ "${NODE_ENV:-}" = "production" ]; then
      error "REFUSING to reset a production database. Set NODE_ENV != production."
    fi
    echo -e "${RED}${BOLD}WARNING: This will DROP and recreate the entire database!${RESET}"
    echo -e "${YELLOW}All data will be permanently lost.${RESET}"
    echo ""
    read -rp "Type 'yes I am sure' to confirm: " CONFIRM
    if [ "$CONFIRM" != "yes I am sure" ]; then
      log "Aborted."
      exit 0
    fi
    log "Resetting database..."
    run_prisma migrate reset --force
    success "Database reset and all migrations reapplied."
    ;;

  status)
    log "Migration status:"
    run_prisma migrate status
    ;;

  generate)
    log "Regenerating Prisma client from schema..."
    run_prisma generate
    success "Prisma client regenerated."
    ;;

  studio)
    log "Opening Prisma Studio..."
    log "Studio will be available at http://localhost:5555"
    run_prisma studio
    ;;

  diff)
    log "Showing schema diff (what would be migrated)..."
    run_prisma migrate diff \
      --from-migrations ./prisma/migrations \
      --to-schema-datamodel ./prisma/schema.prisma \
      --shadow-database-url "${SHADOW_DATABASE_URL:-$DATABASE_URL}" \
      --script
    ;;

  help|--help|-h)
    cat << 'EOF'
Usage: ./scripts/migrate.sh <command> [options]

Commands:
  deploy              Apply all pending migrations (production-safe)
  dev [--name <name>] Create + apply a new migration (dev only)
  reset               Drop DB and reapply all migrations (DESTRUCTIVE, dev only)
  status              Show current migration status
  generate            Regenerate Prisma client from schema.prisma
  studio              Open Prisma Studio GUI (browser-based DB viewer)
  diff                Show SQL diff of pending changes

Environment variables:
  DATABASE_URL        PostgreSQL connection string (required)
  SHADOW_DATABASE_URL Used for diff command (defaults to DATABASE_URL)
  NODE_ENV            Prevents destructive commands in 'production'
EOF
    ;;

  *)
    error "Unknown command: $COMMAND. Run './scripts/migrate.sh help' for usage."
    ;;
esac
