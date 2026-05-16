#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# SnapTrace – Local Development Setup Script
#
# Usage:
#   chmod +x scripts/setup.sh
#   ./scripts/setup.sh [--no-docker] [--no-seed] [--reset]
#
# Options:
#   --no-docker   Skip starting Docker services (assumes postgres/redis running)
#   --no-seed     Skip database seeding
#   --reset       Drop and recreate the database (WARNING: destroys all data)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Flags ────────────────────────────────────────────────────────────────────
NO_DOCKER=false
NO_SEED=false
RESET_DB=false

for arg in "$@"; do
  case $arg in
    --no-docker) NO_DOCKER=true ;;
    --no-seed)   NO_SEED=true ;;
    --reset)     RESET_DB=true ;;
    --help|-h)
      echo "Usage: $0 [--no-docker] [--no-seed] [--reset]"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $arg${RESET}"
      exit 1
      ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────
log()     { echo -e "${BLUE}[setup]${RESET} $*"; }
success() { echo -e "${GREEN}[setup] $*${RESET}"; }
warn()    { echo -e "${YELLOW}[setup] WARNING: $*${RESET}"; }
error()   { echo -e "${RED}[setup] ERROR: $*${RESET}" >&2; }
step()    { echo -e "\n${BOLD}${CYAN}==> $*${RESET}"; }

# ── Root directory detection ───────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"
log "Working directory: $ROOT_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Check prerequisites
# ─────────────────────────────────────────────────────────────────────────────
step "Checking prerequisites"

MISSING=()

# Node.js check (>= 18)
if command -v node &>/dev/null; then
  NODE_VER=$(node -e "process.exit(parseInt(process.versions.node.split('.')[0]) < 18 ? 1 : 0)" 2>/dev/null && node -e "process.stdout.write(process.versions.node)" || echo "too-old")
  if node -e "process.exit(parseInt(process.versions.node.split('.')[0]) < 18 ? 1 : 0)" 2>/dev/null; then
    success "Node.js: $(node --version)"
  else
    error "Node.js >= 18 required. Found: $(node --version)"
    MISSING+=("node >= 18")
  fi
else
  error "Node.js not found. Install from https://nodejs.org/"
  MISSING+=("node")
fi

# pnpm check
if command -v pnpm &>/dev/null; then
  success "pnpm: $(pnpm --version)"
else
  warn "pnpm not found. Attempting to install via corepack..."
  if command -v corepack &>/dev/null; then
    corepack enable && corepack prepare pnpm@8.15.0 --activate
    success "pnpm installed: $(pnpm --version)"
  else
    error "pnpm not found. Install with: npm install -g pnpm"
    MISSING+=("pnpm")
  fi
fi

# Docker check (only if not skipped)
if [ "$NO_DOCKER" = false ]; then
  if command -v docker &>/dev/null; then
    if docker info &>/dev/null; then
      success "Docker: $(docker --version | cut -d' ' -f3 | tr -d ',')"
    else
      error "Docker daemon is not running. Please start Docker."
      MISSING+=("docker daemon")
    fi
  else
    error "Docker not found. Install from https://docs.docker.com/get-docker/"
    MISSING+=("docker")
  fi

  if command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
    success "Docker Compose: $(docker compose version --short 2>/dev/null || echo 'available')"
  else
    error "Docker Compose v2 not found."
    MISSING+=("docker compose v2")
  fi
fi

if [ ${#MISSING[@]} -gt 0 ]; then
  error "Missing prerequisites: ${MISSING[*]}"
  echo "Please install the missing tools and re-run this script."
  exit 1
fi

success "All prerequisites satisfied"

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Environment files
# ─────────────────────────────────────────────────────────────────────────────
step "Setting up environment files"

# Root .env.example → .env
if [ -f ".env.example" ] && [ ! -f ".env" ]; then
  cp .env.example .env
  success "Created .env from .env.example"
  warn "Review and update .env with your configuration before proceeding"
elif [ ! -f ".env" ]; then
  log "Creating default .env file..."
  cat > .env << 'EOF'
# ── Database ──────────────────────────────────
POSTGRES_DB=jamdb
POSTGRES_USER=jam
POSTGRES_PASSWORD=jampassword_change_in_production
POSTGRES_PORT=5432

# ── Redis ─────────────────────────────────────
REDIS_PORT=6379
REDIS_PASSWORD=

# ── Backend ───────────────────────────────────
PORT=5000
NODE_ENV=development
DATABASE_URL=postgresql://jam:jampassword_change_in_production@localhost:5432/jamdb
REDIS_URL=redis://localhost:6379

# ── Auth ──────────────────────────────────────
JWT_SECRET=change-this-to-a-secure-random-string-in-production
JWT_EXPIRES_IN=7d

# ── Cloudinary ────────────────────────────────
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# ── CORS ──────────────────────────────────────
CORS_ORIGIN=http://localhost:3001
MAX_UPLOAD_SIZE_MB=500

# ── Frontend build vars ───────────────────────
VITE_API_URL=http://localhost:5000/api
VITE_WS_URL=ws://localhost:5000

# ── Dashboard port ────────────────────────────
DASHBOARD_PORT=3001
BACKEND_PORT=5000
EOF
  success "Created default .env file"
  warn "IMPORTANT: Update JWT_SECRET and POSTGRES_PASSWORD before using in production!"
fi

# Backend-specific .env (if separate)
if [ -f "backend/.env.example" ] && [ ! -f "backend/.env" ]; then
  cp backend/.env.example backend/.env
  success "Created backend/.env"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Install dependencies
# ─────────────────────────────────────────────────────────────────────────────
step "Installing dependencies"

pnpm install --frozen-lockfile || pnpm install
success "Dependencies installed"

# ─────────────────────────────────────────────────────────────────────────────
# Step 4: Start infrastructure services (Docker)
# ─────────────────────────────────────────────────────────────────────────────
if [ "$NO_DOCKER" = false ]; then
  step "Starting infrastructure services (PostgreSQL + Redis)"

  if [ "$RESET_DB" = true ]; then
    warn "RESET mode: removing existing postgres volume..."
    docker compose down -v postgres redis 2>/dev/null || true
  fi

  # Start only DB and Redis (not the app containers)
  docker compose up -d postgres redis

  log "Waiting for PostgreSQL to be ready..."
  MAX_RETRIES=30
  RETRY=0
  until docker compose exec -T postgres pg_isready -U "${POSTGRES_USER:-jam}" -d "${POSTGRES_DB:-jamdb}" &>/dev/null; do
    RETRY=$((RETRY + 1))
    if [ $RETRY -ge $MAX_RETRIES ]; then
      error "PostgreSQL did not become healthy after ${MAX_RETRIES} attempts"
      docker compose logs postgres
      exit 1
    fi
    log "Waiting... (${RETRY}/${MAX_RETRIES})"
    sleep 2
  done
  success "PostgreSQL is ready"

  log "Waiting for Redis to be ready..."
  RETRY=0
  until docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; do
    RETRY=$((RETRY + 1))
    if [ $RETRY -ge $MAX_RETRIES ]; then
      error "Redis did not become healthy after ${MAX_RETRIES} attempts"
      docker compose logs redis
      exit 1
    fi
    log "Waiting... (${RETRY}/${MAX_RETRIES})"
    sleep 2
  done
  success "Redis is ready"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 5: Run Prisma migrations
# ─────────────────────────────────────────────────────────────────────────────
step "Running database migrations"

# Source .env to get DATABASE_URL
set -a
# shellcheck source=/dev/null
[ -f .env ] && source .env
set +a

if [ -d "backend/prisma" ]; then
  cd backend

  log "Generating Prisma client..."
  npx prisma generate 2>/dev/null || pnpm exec prisma generate || true

  log "Applying migrations..."
  if [ "$RESET_DB" = true ]; then
    warn "Resetting database schema..."
    npx prisma migrate reset --force --skip-seed 2>/dev/null || pnpm exec prisma migrate reset --force --skip-seed || true
  else
    npx prisma migrate deploy 2>/dev/null || pnpm exec prisma migrate deploy || true
  fi

  success "Database migrations applied"
  cd "$ROOT_DIR"
else
  warn "No prisma directory found in backend/. Skipping migrations."
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 6: Seed database
# ─────────────────────────────────────────────────────────────────────────────
if [ "$NO_SEED" = false ]; then
  step "Seeding database"

  if [ -f "scripts/seed.ts" ]; then
    log "Running seed script..."
    npx tsx scripts/seed.ts 2>/dev/null || \
      npx ts-node scripts/seed.ts 2>/dev/null || \
      node --loader ts-node/esm scripts/seed.ts 2>/dev/null || \
      warn "Seed script failed or ts runner not found. Run manually: npx tsx scripts/seed.ts"
    success "Database seeded"
  else
    warn "No seed script found at scripts/seed.ts. Skipping."
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 7: Done
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}╔═══════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}${BOLD}║         Setup complete! Ready to develop.         ║${RESET}"
echo -e "${GREEN}${BOLD}╚═══════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${CYAN}Start backend:${RESET}        cd backend && pnpm dev"
echo -e "  ${CYAN}Start dashboard:${RESET}      pnpm --filter @snaptrace/dashboard dev"
echo -e "  ${CYAN}Start extension:${RESET}      pnpm --filter @snaptrace/extension dev"
echo -e "  ${CYAN}Start all (turbo):${RESET}    pnpm dev"
echo ""
echo -e "  ${CYAN}Backend API:${RESET}          http://localhost:${PORT:-5000}"
echo -e "  ${CYAN}Dashboard:${RESET}            http://localhost:${DASHBOARD_PORT:-3001}"
echo ""
echo -e "  ${YELLOW}Tip:${RESET} Edit ${BOLD}.env${RESET} to configure Cloudinary and other secrets"
echo ""
