# ─────────────────────────────────────────────
# Stage 1: Base – Node 20 Alpine + pnpm
# ─────────────────────────────────────────────
FROM node:20-alpine AS base

RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

# ─────────────────────────────────────────────
# Stage 2: Dependencies
# ─────────────────────────────────────────────
FROM base AS deps

WORKDIR /app

# Copy workspace manifests for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./

COPY packages/types/package.json ./packages/types/
COPY packages/config/package.json ./packages/config/
COPY packages/tsconfig/package.json ./packages/tsconfig/
COPY packages/eslint-config/package.json ./packages/eslint-config/

COPY apps/dashboard/package.json ./apps/dashboard/

RUN pnpm install --frozen-lockfile

# ─────────────────────────────────────────────
# Stage 3: Builder – Vite production build
# ─────────────────────────────────────────────
FROM deps AS builder

WORKDIR /app

# Build arguments for environment variables baked at build time
ARG VITE_API_URL=http://localhost/api
ARG VITE_WS_URL=ws://localhost
ARG VITE_APP_ENV=production

ENV VITE_API_URL=${VITE_API_URL} \
    VITE_WS_URL=${VITE_WS_URL} \
    VITE_APP_ENV=${VITE_APP_ENV}

# Copy shared packages source
COPY packages/ ./packages/

# Copy dashboard source
COPY apps/dashboard/ ./apps/dashboard/

# Build shared packages
RUN pnpm --filter "@jam/types" build 2>/dev/null || true

# Build the dashboard
WORKDIR /app/apps/dashboard
RUN pnpm run build

# ─────────────────────────────────────────────
# Stage 4: Production – Nginx serving static files
# ─────────────────────────────────────────────
FROM nginx:1.25-alpine AS production

# Install curl for healthcheck
RUN apk add --no-cache curl

# Remove default nginx config
RUN rm -f /etc/nginx/conf.d/default.conf

# Copy custom nginx SPA config
COPY docker/nginx-dashboard.conf /etc/nginx/conf.d/default.conf

# Copy built static files from builder
COPY --from=builder /app/apps/dashboard/dist /usr/share/nginx/html

# Set correct permissions
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chmod -R 755 /usr/share/nginx/html

# Expose port 80
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost/health.html || curl -f http://localhost/ || exit 1

# Create health check file
RUN echo "OK" > /usr/share/nginx/html/health.html

CMD ["nginx", "-g", "daemon off;"]
