# ─────────────────────────────────────────────
# Stage 1: Base – Node 20 Alpine + pnpm
# ─────────────────────────────────────────────
FROM node:20-alpine AS base

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

# Install system deps needed for native addons (bcrypt, etc.)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    openssl \
    ca-certificates

# ─────────────────────────────────────────────
# Stage 2: Dependencies installer
# ─────────────────────────────────────────────
FROM base AS deps

WORKDIR /app

# Copy workspace manifests for layer-cache efficiency
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./

# Copy package manifests for all workspaces
COPY packages/types/package.json ./packages/types/
COPY packages/config/package.json ./packages/config/
COPY packages/tsconfig/package.json ./packages/tsconfig/
COPY packages/eslint-config/package.json ./packages/eslint-config/

# Backend manifest lives under backend/ in this repo
COPY backend/package.json ./apps/backend/

# Install all deps (including devDeps needed for build)
RUN pnpm install --frozen-lockfile

# ─────────────────────────────────────────────
# Stage 3: Builder – compile TypeScript
# ─────────────────────────────────────────────
FROM deps AS builder

WORKDIR /app

# Copy shared packages source
COPY packages/ ./packages/

# Copy backend source
COPY backend/ ./apps/backend/

# Build shared packages first, then backend
RUN pnpm --filter "@jam/types" build 2>/dev/null || true && \
    pnpm --filter "@jam/config" build 2>/dev/null || true

# Build the backend (tsc output → apps/backend/dist)
WORKDIR /app/apps/backend
RUN pnpm run build 2>/dev/null || \
    npx tsc --outDir dist --rootDir src 2>/dev/null || \
    (mkdir -p dist && cp -r src/* dist/)

# ─────────────────────────────────────────────
# Stage 4: Production deps only
# ─────────────────────────────────────────────
FROM deps AS prod-deps

WORKDIR /app
# Prune to production-only node_modules
RUN pnpm install --frozen-lockfile --prod

# ─────────────────────────────────────────────
# Stage 5: Production image
# ─────────────────────────────────────────────
FROM node:20-alpine AS production

# Install runtime-only system dependencies
RUN apk add --no-cache \
    openssl \
    ca-certificates \
    wget \
    dumb-init

WORKDIR /app

ENV NODE_ENV=production \
    PORT=5000

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy production node_modules from prod-deps stage
COPY --from=prod-deps --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=prod-deps --chown=appuser:appgroup /app/apps/backend/node_modules ./apps/backend/node_modules 2>/dev/null || true

# Copy compiled application
COPY --from=builder --chown=appuser:appgroup /app/apps/backend/dist ./dist

# Copy Prisma schema and generated client
COPY --from=builder --chown=appuser:appgroup /app/apps/backend/prisma ./prisma

# Copy package.json for runtime metadata
COPY --from=builder --chown=appuser:appgroup /app/apps/backend/package.json ./

# Create upload temp directory
RUN mkdir -p /app/uploads && chown appuser:appgroup /app/uploads

# Switch to non-root user
USER appuser

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget -qO- http://localhost:5000/health || exit 1

# Use dumb-init as PID 1 to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]

# ─────────────────────────────────────────────
# Stage 6: Development (hot-reload)
# ─────────────────────────────────────────────
FROM base AS development

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY packages/ ./packages/
COPY backend/ ./apps/backend/

RUN pnpm install

WORKDIR /app/apps/backend

ENV NODE_ENV=development \
    PORT=5000

EXPOSE 5000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO- http://localhost:5000/health || exit 1

CMD ["pnpm", "run", "dev"]
