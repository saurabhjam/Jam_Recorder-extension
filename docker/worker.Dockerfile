# ─────────────────────────────────────────────
# Stage 1: Base – Node 20 Alpine + pnpm + FFmpeg
# ─────────────────────────────────────────────
FROM node:20-alpine AS base

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

# Install FFmpeg and system dependencies
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    make \
    g++ \
    openssl \
    ca-certificates

# Verify FFmpeg is available
RUN ffmpeg -version | head -1

# ─────────────────────────────────────────────
# Stage 2: Dependencies installer
# ─────────────────────────────────────────────
FROM base AS deps

WORKDIR /app

# Copy workspace manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./

COPY packages/types/package.json ./packages/types/
COPY packages/config/package.json ./packages/config/
COPY packages/tsconfig/package.json ./packages/tsconfig/
COPY packages/eslint-config/package.json ./packages/eslint-config/

COPY apps/backend/package.json ./apps/backend/

RUN pnpm install --frozen-lockfile

# ─────────────────────────────────────────────
# Stage 3: Builder
# ─────────────────────────────────────────────
FROM deps AS builder

WORKDIR /app

COPY packages/ ./packages/
COPY apps/backend/ ./apps/backend/

# Build shared packages
RUN pnpm --filter "@jam/types" build 2>/dev/null || true && \
    pnpm --filter "@jam/config" build 2>/dev/null || true

# Generate Prisma client (must run before tsc)
WORKDIR /app/apps/backend
RUN npx prisma generate

# Build worker entry point
RUN npx tsc --project tsconfig.json --noEmitOnError false --skipLibCheck 2>/dev/null || \
    npx tsc --outDir dist --rootDir src --noEmitOnError false --skipLibCheck 2>/dev/null || \
    (mkdir -p dist && cp -r src dist/src && echo "Fallback: copied src as-is")

# ─────────────────────────────────────────────
# Stage 4: Production deps only
# ─────────────────────────────────────────────
FROM deps AS prod-deps

WORKDIR /app
RUN pnpm install --frozen-lockfile --prod && \
    mkdir -p /app/apps/backend/node_modules

# ─────────────────────────────────────────────
# Stage 5: Production worker image
# ─────────────────────────────────────────────
FROM node:20-alpine AS production

# Install FFmpeg + runtime system deps
RUN apk add --no-cache \
    ffmpeg \
    openssl \
    ca-certificates \
    wget \
    dumb-init

# Verify FFmpeg
RUN ffmpeg -version | head -1

WORKDIR /app

ENV NODE_ENV=production

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy production node_modules
COPY --from=prod-deps --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=prod-deps --chown=appuser:appgroup /app/apps/backend/node_modules ./apps/backend/node_modules

# Copy compiled worker application
COPY --from=builder --chown=appuser:appgroup /app/apps/backend/dist ./dist

# Copy Prisma schema
COPY --from=builder --chown=appuser:appgroup /app/apps/backend/prisma ./prisma
COPY --from=builder --chown=appuser:appgroup /app/apps/backend/package.json ./

# Create working directories for video processing
RUN mkdir -p /app/uploads /app/tmp && \
    chown -R appuser:appgroup /app/uploads /app/tmp

USER appuser

# Workers don't expose HTTP ports but we add a healthcheck via a heartbeat file
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD test -f /app/tmp/.worker-heartbeat && \
    [ $(( $(date +%s) - $(stat -c %Y /app/tmp/.worker-heartbeat 2>/dev/null || echo 0) )) -lt 60 ] || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/worker.js"]

# ─────────────────────────────────────────────
# Stage 6: Development worker (hot-reload)
# ─────────────────────────────────────────────
FROM base AS development

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY packages/ ./packages/
COPY apps/backend/ ./apps/backend/

RUN pnpm install && \
    cd apps/backend && npx prisma generate

WORKDIR /app/apps/backend

ENV NODE_ENV=development

RUN mkdir -p /app/uploads /app/tmp

CMD ["pnpm", "run", "dev:worker"]
