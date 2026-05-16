# Local Development Setup

## Prerequisites

Before you begin, ensure the following tools are installed:

| Tool           | Version | Install                                    |
| -------------- | ------- | ------------------------------------------ |
| Node.js        | >= 18   | https://nodejs.org/ or `nvm install 20`    |
| pnpm           | >= 8    | `npm install -g pnpm` or `corepack enable` |
| Docker         | latest  | https://docs.docker.com/get-docker/        |
| Docker Compose | v2+     | Included with Docker Desktop               |
| Git            | any     | https://git-scm.com/                       |
| Chrome         | any     | For loading the extension                  |

---

## Quick Start (Automated)

The setup script handles everything automatically:

```bash
git clone https://github.com/your-username/snaptrace.git
cd snaptrace

chmod +x scripts/setup.sh
./scripts/setup.sh
```

The script will:

1. Check prerequisites
2. Create `.env` from the template
3. Install all pnpm workspace dependencies
4. Start PostgreSQL and Redis via Docker
5. Run Prisma migrations
6. Seed the database with demo data

After setup completes:

- Backend API: http://localhost:5000
- Dashboard: http://localhost:3001

---

## Manual Step-by-Step Setup

### 1. Clone the repository

```bash
git clone https://github.com/your-username/snaptrace.git
cd snaptrace
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in the required values (see the Environment Variables section below).

### 4. Start infrastructure services

```bash
# Start PostgreSQL and Redis only
docker compose up -d postgres redis

# Verify they're healthy
docker compose ps
```

### 5. Run database migrations

```bash
cd backend
npx prisma migrate dev
cd ..
```

### 6. Seed the database (optional)

```bash
npx tsx scripts/seed.ts
```

### 7. Start development servers

You can start everything with Turborepo:

```bash
pnpm dev
```

Or start each service individually in separate terminals:

```bash
# Terminal 1: Backend API
cd backend && pnpm dev

# Terminal 2: Dashboard
pnpm --filter @snaptrace/dashboard dev

# Terminal 3: Extension (watch mode)
pnpm --filter @snaptrace/extension dev
```

---

## Environment Variables

All environment variables live in the root `.env` file. Copy `.env.example` to get started.

### Required Variables

| Variable                | Example                                                  | Description                   |
| ----------------------- | -------------------------------------------------------- | ----------------------------- |
| `POSTGRES_DB`           | `snaptracedb`                                            | PostgreSQL database name      |
| `POSTGRES_USER`         | `snaptrace`                                              | PostgreSQL username           |
| `POSTGRES_PASSWORD`     | `change_me_in_production`                                | PostgreSQL password           |
| `DATABASE_URL`          | `postgresql://snaptrace:pass@localhost:5432/snaptracedb` | Full Prisma connection string |
| `JWT_SECRET`            | (long random string)                                     | Secret for signing JWT tokens |
| `CLOUDINARY_CLOUD_NAME` | `my-cloud`                                               | Your Cloudinary cloud name    |
| `CLOUDINARY_API_KEY`    | `123456789012345`                                        | Cloudinary API key            |
| `CLOUDINARY_API_SECRET` | `AbCdEfGhIjKlMnOpQrStUvWx`                               | Cloudinary API secret         |

### Optional Variables

| Variable             | Default                     | Description                            |
| -------------------- | --------------------------- | -------------------------------------- |
| `PORT`               | `5000`                      | Backend HTTP port                      |
| `REDIS_URL`          | `redis://localhost:6379`    | Redis connection URL                   |
| `REDIS_PASSWORD`     | (none)                      | Redis password (if set)                |
| `JWT_EXPIRES_IN`     | `7d`                        | JWT access token expiry                |
| `CORS_ORIGIN`        | `http://localhost:3001`     | Allowed CORS origin for API            |
| `MAX_UPLOAD_SIZE_MB` | `500`                       | Max video upload size in megabytes     |
| `VITE_API_URL`       | `http://localhost:5000/api` | API URL baked into dashboard build     |
| `VITE_WS_URL`        | `ws://localhost:5000`       | WebSocket URL for dashboard            |
| `NODE_ENV`           | `development`               | `development`, `test`, or `production` |

### Generating a JWT Secret

```bash
# macOS/Linux
openssl rand -base64 64

# Node.js
node -e "console.log(require('crypto').randomBytes(64).toString('base64'))"
```

---

## Cloudinary Setup

Cloudinary is used for storing and delivering all video recordings and thumbnails.

1. Create a free account at https://cloudinary.com/

2. From your dashboard, note your:
   - **Cloud name** (e.g., `dxk4j3abc`)
   - **API Key**
   - **API Secret**

3. Add them to your `.env`:

   ```bash
   CLOUDINARY_CLOUD_NAME=dxk4j3abc
   CLOUDINARY_API_KEY=123456789012345
   CLOUDINARY_API_SECRET=AbCdEfGhIjKlMnOpQrStUvWxyz
   ```

4. (Optional) Create a dedicated folder in Cloudinary:
   - Go to Media Library → New Folder → name it `snaptrace`
   - The app will upload to `snaptrace/recordings/` and `snaptrace/thumbnails/`

5. (Optional) Set up an upload preset for direct browser uploads:
   - Settings → Upload → Upload presets → Add upload preset
   - Set mode: Unsigned, folder: `snaptrace`

---

## Loading the Extension in Chrome

The extension must be loaded in Developer Mode.

### Development (watch mode)

1. Start the extension dev server:

   ```bash
   pnpm --filter @snaptrace/extension dev
   ```

   This watches `apps/extension/src/` and rebuilds to `apps/extension/dist/` on changes.

2. Open Chrome and navigate to `chrome://extensions/`

3. Enable **Developer mode** (top right toggle)

4. Click **Load unpacked**

5. Select the `apps/extension/dist/` folder

6. The SnapTrace Recorder extension will appear in your extensions list

7. Pin it to the toolbar for easy access

### Production build

```bash
pnpm --filter @snaptrace/extension build:prod
```

The `apps/extension/dist/` folder can be zipped and submitted to the Chrome Web Store.

---

## Running Tests

```bash
# Run all tests
pnpm test

# Backend tests only
pnpm --filter backend test

# With coverage report
pnpm --filter backend test --coverage

# Watch mode (re-runs on file changes)
pnpm --filter backend test --watch
```

---

## Common Issues

### Port already in use

```
Error: listen EADDRINUSE: address already in use :::5000
```

Solution: Kill the process using the port:

```bash
lsof -ti:5000 | xargs kill -9
lsof -ti:5432 | xargs kill -9  # If PostgreSQL port is in use
```

---

### Prisma client not generated

```
Error: @prisma/client did not initialize yet
```

Solution:

```bash
cd backend && npx prisma generate
```

---

### Docker containers not healthy

```bash
# View container logs
docker compose logs postgres
docker compose logs redis

# Restart a specific service
docker compose restart postgres

# Full reset
docker compose down -v
docker compose up -d postgres redis
```

---

### pnpm install fails due to lockfile

```
ERR_PNPM_OUTDATED_LOCKFILE
```

Solution:

```bash
pnpm install --no-frozen-lockfile
```

---

### Cloudinary upload fails

- Verify your `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` in `.env`
- Check your Cloudinary plan limits (free tier: 25 credits/month)
- Ensure the `snaptrace/` folder exists or auto-creation is enabled in your account

---

### Extension content script not injecting

- Ensure the extension is loaded from `apps/extension/dist/` (not `src/`)
- After rebuilding, click the reload icon on `chrome://extensions/`
- Check for errors in the extension's background page console:
  `chrome://extensions/` → Details → Inspect views: background page

---

## Database Management

```bash
# View migration status
./scripts/migrate.sh status

# Create a new migration
./scripts/migrate.sh dev --name your_migration_name

# Open database GUI
./scripts/migrate.sh studio
# → Opens Prisma Studio at http://localhost:5555

# Reset database (WARNING: destroys all data)
./scripts/migrate.sh reset
```
