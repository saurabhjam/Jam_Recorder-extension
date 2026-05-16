# Deployment Guide

## Overview

SnapTrace is deployed as a set of Docker containers orchestrated by Docker Compose. The recommended deployment target is a single Linux VPS (Ubuntu 22.04 LTS) for small-to-medium teams, with a path to horizontal scaling.

```
                     Internet
                        │
                        ▼
             ┌──────────────────┐
             │    Nginx (80/443) │   ← SSL termination, rate limiting
             └────────┬─────────┘
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
      Backend       Worker    Dashboard
     (Express)    (FFmpeg)   (Nginx SPA)
          │           │
          └─────┬─────┘
                │
       ┌────────┼────────┐
       ▼        ▼        ▼
   PostgreSQL  Redis  Cloudinary
```

---

## Server Requirements

### Minimum (small team, < 20 users)

| Resource | Minimum          | Recommended      |
| -------- | ---------------- | ---------------- |
| CPU      | 2 vCPU           | 4 vCPU           |
| RAM      | 4 GB             | 8 GB             |
| Disk     | 40 GB SSD        | 100 GB SSD       |
| OS       | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |
| Network  | 100 Mbps         | 1 Gbps           |

### Recommended providers

- DigitalOcean Droplet (Basic, $24/mo for 4 vCPU / 8 GB)
- Hetzner Cloud (CX31, ~$12/mo for 2 vCPU / 8 GB)
- AWS EC2 (t3.large)
- Linode / Akamai (Dedicated 8 GB)

---

## Initial Server Setup

### 1. SSH into the server

```bash
ssh root@your-server-ip
```

### 2. Create a deploy user

```bash
adduser deploy
usermod -aG sudo deploy
usermod -aG docker deploy

# Add your SSH key to the deploy user
mkdir -p /home/deploy/.ssh
cat >> /home/deploy/.ssh/authorized_keys << 'EOF'
YOUR_PUBLIC_SSH_KEY_HERE
EOF
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
```

### 3. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker
```

### 4. Install Docker Compose (v2)

```bash
# Included with Docker >= 20.10 via the compose plugin
docker compose version  # Verify
```

### 5. Configure firewall

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status
```

---

## Application Deployment

### 1. Clone the repository

```bash
su - deploy
mkdir -p /opt/snaptrace
cd /opt/snaptrace
git clone https://github.com/your-username/snaptrace.git .
```

### 2. Configure environment

```bash
cp .env.example .env
nano .env
```

Set all required values (see the Environment Variables section in SETUP.md). Critical production settings:

```bash
NODE_ENV=production
JWT_SECRET=<64-char-random-string>
POSTGRES_PASSWORD=<strong-password>
CLOUDINARY_CLOUD_NAME=<your-cloud>
CLOUDINARY_API_KEY=<your-key>
CLOUDINARY_API_SECRET=<your-secret>
CORS_ORIGIN=https://your-domain.com
VITE_API_URL=https://your-domain.com/api
VITE_WS_URL=wss://your-domain.com
```

### 3. Create SSL directory (even if not using SSL yet)

```bash
mkdir -p ssl
```

### 4. Build and start all services

```bash
docker compose build
docker compose up -d
```

### 5. Run database migrations

```bash
docker compose exec backend node dist/migrate.js
# or using the helper script:
./scripts/migrate.sh deploy
```

### 6. Verify deployment

```bash
docker compose ps          # All containers should be Up
curl http://localhost/nginx-health   # Should return "healthy"
curl http://localhost/api/health     # Should return JSON status
```

---

## Nginx SSL Setup (HTTPS)

### Using Let's Encrypt (Certbot)

#### 1. Install Certbot

```bash
sudo apt install -y certbot
```

#### 2. Stop Nginx temporarily

```bash
docker compose stop nginx
```

#### 3. Obtain certificate

```bash
certbot certonly --standalone \
  -d your-domain.com \
  -d www.your-domain.com \
  --email admin@your-domain.com \
  --agree-tos \
  --non-interactive
```

#### 4. Copy certificates to ssl/ directory

```bash
cp /etc/letsencrypt/live/your-domain.com/fullchain.pem ssl/
cp /etc/letsencrypt/live/your-domain.com/privkey.pem ssl/
chmod 644 ssl/fullchain.pem
chmod 600 ssl/privkey.pem
```

#### 5. Enable HTTPS in Nginx config

Edit `nginx/nginx.conf`:

- Uncomment the HTTP → HTTPS redirect block
- Uncomment the `server { listen 443 ssl http2; ... }` block
- Update `server_name` to your domain
- Copy all location blocks from the HTTP server into the HTTPS server

#### 6. Restart Nginx

```bash
docker compose up -d nginx
```

#### 7. Set up automatic renewal

```bash
# Test renewal
certbot renew --dry-run

# Add cron job for automatic renewal
(crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet && cp /etc/letsencrypt/live/your-domain.com/fullchain.pem /opt/snaptrace/ssl/ && cp /etc/letsencrypt/live/your-domain.com/privkey.pem /opt/snaptrace/ssl/ && docker compose -f /opt/snaptrace/docker-compose.yml exec nginx nginx -s reload") | crontab -
```

---

## Environment Configuration

### Production `.env` checklist

```bash
# ── Security (MUST change) ──────────────────────────────────
NODE_ENV=production
JWT_SECRET=<openssl rand -base64 64>
POSTGRES_PASSWORD=<strong random password>
REDIS_PASSWORD=<strong random password if exposing Redis>

# ── Database ────────────────────────────────────────────────
POSTGRES_DB=snaptracedb
POSTGRES_USER=snaptrace
DATABASE_URL=postgresql://snaptrace:<password>@postgres:5432/snaptracedb

# ── Redis ───────────────────────────────────────────────────
REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379

# ── Cloudinary (required for video storage) ─────────────────
CLOUDINARY_CLOUD_NAME=your-cloud
CLOUDINARY_API_KEY=your-key
CLOUDINARY_API_SECRET=your-secret

# ── URLs (update to your actual domain) ─────────────────────
CORS_ORIGIN=https://your-domain.com
VITE_API_URL=https://your-domain.com/api
VITE_WS_URL=wss://your-domain.com

# ── Limits ──────────────────────────────────────────────────
MAX_UPLOAD_SIZE_MB=500
JWT_EXPIRES_IN=7d
```

---

## Database Migrations in Production

**Never use `migrate dev` in production.** Always use `migrate deploy`.

```bash
# Apply pending migrations safely
docker compose exec backend node dist/migrate.js

# Or using the helper script (from the server)
./scripts/migrate.sh deploy
```

### Rollback strategy

Prisma does not support automatic rollbacks. If a migration fails:

1. Identify the failing SQL in the migration file
2. Manually revert the change in the database using `psql`
3. Update `_prisma_migrations` table to mark the migration as failed
4. Fix the migration file and re-run `migrate deploy`

### Backup before migrating

```bash
# Create a backup
docker compose exec postgres pg_dump \
  -U ${POSTGRES_USER} \
  -d ${POSTGRES_DB} \
  -Fc > backup_$(date +%Y%m%d_%H%M%S).dump

# Restore from backup
docker compose exec -T postgres pg_restore \
  -U ${POSTGRES_USER} \
  -d ${POSTGRES_DB} \
  --clean \
  < backup_20240514_120000.dump
```

---

## Updating the Application

### Rolling update (zero downtime for stateless containers)

```bash
cd /opt/snaptrace

# Pull latest code
git pull origin main

# Rebuild images
docker compose build backend worker dashboard

# Rolling restart (DB and Redis stay up)
docker compose up -d --no-deps backend worker dashboard nginx

# Apply migrations
docker compose exec -T backend node dist/migrate.js

# Verify
docker compose ps
curl http://localhost/api/health
```

### Full restart

```bash
docker compose restart
```

### Emergency rollback

```bash
# Revert to previous Git commit
git log --oneline -5
git reset --hard <previous-commit-sha>

# Rebuild and restart
docker compose build backend worker dashboard
docker compose up -d --no-deps backend worker dashboard
```

---

## Monitoring

### Container health and resource usage

```bash
# Live stats for all containers
docker stats

# Logs (follow)
docker compose logs -f backend
docker compose logs -f worker
docker compose logs -f nginx

# All logs, last 100 lines
docker compose logs --tail=100
```

### Setting up basic monitoring with Docker health checks

All containers include `HEALTHCHECK` directives. View health status:

```bash
docker inspect snaptrace_backend --format='{{.State.Health.Status}}'
docker inspect snaptrace_postgres --format='{{.State.Health.Status}}'
```

### Log rotation

Docker's `json-file` driver is configured in `docker-compose.yml` with:

- `max-size: 10m` — rotate at 10 MB
- `max-file: 3` — keep 3 rotated files

For production, consider shipping logs to an external service:

- **Datadog**: Use the `datadog/agent` container with Docker log collection
- **Grafana Loki**: Lightweight, open-source log aggregation
- **AWS CloudWatch**: If deployed on AWS

### Recommended monitoring stack

For a production deployment, consider adding:

1. **Uptime monitoring**: Uptime Kuma (self-hosted) or Betterstack

   ```bash
   # Monitor: GET /api/health → expects 200 OK
   ```

2. **Error tracking**: Sentry

   ```bash
   # Install in backend: pnpm --filter backend add @sentry/node
   ```

3. **Metrics**: Prometheus + Grafana
   ```bash
   # Expose /metrics from Express using prom-client
   ```

---

## Backup Strategy

### Automated daily backups

Create `/opt/snaptrace/scripts/backup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="/opt/snaptrace/backups"
DATE=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=7

mkdir -p "$BACKUP_DIR"

# Database backup
docker compose -f /opt/snaptrace/docker-compose.yml exec -T postgres \
  pg_dump -U snaptrace -d snaptracedb -Fc > "$BACKUP_DIR/db_${DATE}.dump"

# Remove old backups
find "$BACKUP_DIR" -name "*.dump" -mtime +${RETENTION_DAYS} -delete

echo "Backup completed: db_${DATE}.dump"
```

```bash
chmod +x /opt/snaptrace/scripts/backup.sh

# Daily backup at 2 AM
(crontab -l 2>/dev/null; echo "0 2 * * * /opt/snaptrace/scripts/backup.sh >> /var/log/snaptrace-backup.log 2>&1") | crontab -
```

---

## Security Checklist

- [ ] `JWT_SECRET` is at least 64 random characters
- [ ] `POSTGRES_PASSWORD` is a strong password (not default)
- [ ] `.env` file permissions: `chmod 600 .env`
- [ ] SSH key authentication only (no password login)
- [ ] UFW firewall configured (only ports 22, 80, 443 open)
- [ ] SSL certificate installed and HTTP redirects to HTTPS
- [ ] Docker containers run as non-root users (configured in Dockerfiles)
- [ ] No secrets committed to Git (`.gitignore` covers `.env`)
- [ ] Cloudinary API credentials are server-side only (not baked into frontend)
- [ ] PostgreSQL and Redis ports NOT exposed to the internet (only within Docker network)
- [ ] Regular backups scheduled and tested
- [ ] Nginx rate limiting enabled for API and upload endpoints
