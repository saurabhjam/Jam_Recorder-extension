# SnapTrace

> Enterprise screen recording, bug reporting & async video platform.

[![CI](https://github.com/your-username/snaptrace/actions/workflows/ci.yml/badge.svg)](https://github.com/your-username/snaptrace/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178c6?logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

---

## What is SnapTrace?

SnapTrace is a self-hosted, open-source screen recording and bug reporting platform. It lets engineering and product teams capture, annotate, and share bug reproductions, feature walkthroughs, and async communication without leaving the browser. Ship bugs faster, communicate asynchronously, and never lose context.

---

## Features

### Recording

- Screen recording (full screen, application window, browser tab)
- Webcam overlay recording
- Microphone audio capture
- Pause/resume controls
- Floating recording toolbar
- Keyboard shortcuts

### Bug Reporting

- Screenshot capture + annotation
- Drawing tools (pen, arrow, rectangle, text, blur)
- Console log capture
- Network request capture
- Browser & OS metadata
- Issue title + description

### Collaboration

- Instant shareable links
- Public share pages
- Team workspaces
- Comments + reactions

### Platform

- Beautiful Chrome extension popup
- SaaS web dashboard
- Google OAuth
- JWT authentication
- Chunked video upload
- Cloud storage (Cloudinary / S3-ready)

---

## Tech Stack

| Layer          | Technology                                     |
| -------------- | ---------------------------------------------- |
| Monorepo       | Turborepo + pnpm workspaces                    |
| Extension      | Chrome Extensions MV3, Vite, React 18, Zustand |
| Dashboard      | React 18, Vite, TailwindCSS, Framer Motion     |
| Backend        | Node.js 20, Express 5, TypeScript              |
| ORM            | Prisma (PostgreSQL)                            |
| Auth           | JWT + httpOnly refresh cookies                 |
| Queue          | Redis + BullMQ                                 |
| Video          | FFmpeg (worker), Cloudinary (storage/CDN)      |
| Real-time      | Socket.IO                                      |
| Infrastructure | Docker Compose, Nginx                          |
| CI/CD          | GitHub Actions                                 |

---

## Architecture

```
                         Internet
                             |
                             v
              +----------------------------------+
              |      Nginx Reverse Proxy         |
              |  (SSL termination, rate limiting) |
              +-----------+-----------+----------+
                          |           |
              +-----------+           +-----------+
              |                                   |
              v                                   v
    +-------------------+             +-------------------+
    |    Backend API    |             |  Dashboard (SPA)  |
    |  (Express + TS)   |             |   (React, Vite)   |
    +--------+----------+             +-------------------+
             |
     +-------+--------+
     |                |
     v                v
 PostgreSQL          Redis           Cloudinary CDN
 (primary DB)   (cache + queue)    (video storage)
                      |
                      v
             +------------------+
             |  Background      |
             |  Worker (FFmpeg) |
             +------------------+
```

For full system design and data flow diagrams, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Repo Structure

```
snaptrace/
├── apps/
│   ├── extension/          # Chrome Extension (MV3)
│   │   └── src/
│   │       ├── background/ # Service worker, tab capture
│   │       ├── content/    # Content script, annotation canvas
│   │       ├── popup/      # Extension popup UI
│   │       └── sidepanel/  # Side panel recording list
│   │
│   └── dashboard/          # React web dashboard
│       └── src/
│           ├── pages/      # Route-level components
│           ├── components/ # Shared UI components
│           ├── hooks/      # Custom React hooks
│           └── stores/     # Zustand state stores
│
├── backend/                # Express.js API server
│   ├── src/
│   │   ├── routes/         # API route handlers
│   │   ├── middleware/     # Auth, validation, error handling
│   │   ├── services/       # Business logic
│   │   └── workers/        # BullMQ job processors
│   └── prisma/
│       └── schema.prisma   # Database schema
│
├── packages/
│   ├── types/              # @snaptrace/types — shared TypeScript types
│   ├── config/             # @snaptrace/config — shared configuration constants
│   ├── tsconfig/           # @snaptrace/tsconfig — shared TS configs
│   └── eslint-config/      # @snaptrace/eslint-config — shared ESLint rules
│
├── docker/
│   ├── backend.Dockerfile  # Multi-stage backend image
│   ├── worker.Dockerfile   # Worker image (includes FFmpeg)
│   └── dashboard.Dockerfile# Dashboard image (Nginx SPA)
│
├── nginx/
│   └── nginx.conf          # Main reverse proxy config
│
├── scripts/
│   ├── setup.sh            # One-command local setup
│   ├── migrate.sh          # Database migration helper
│   └── seed.ts             # Database seeder
│
├── docs/
│   ├── ARCHITECTURE.md     # System design and data flows
│   ├── API.md              # Full REST API reference
│   ├── SETUP.md            # Local development guide
│   └── DEPLOYMENT.md       # Production deployment guide
│
├── docker-compose.yml      # Full stack orchestration
├── turbo.json              # Turborepo pipeline
└── pnpm-workspace.yaml     # pnpm workspace configuration
```

---

## Quick Start

### Prerequisites

- Node.js >= 20
- pnpm >= 8 (`npm install -g pnpm`)
- Docker + Docker Compose v2
- A free [Cloudinary](https://cloudinary.com) account

### 1. Clone and install

```bash
git clone https://github.com/your-username/snaptrace.git
cd snaptrace
pnpm install
```

### 2. Configure environment

```bash
cp apps/backend/.env.example apps/backend/.env
# Fill in DATABASE_URL, JWT_SECRET, GOOGLE_CLIENT_ID,
# GOOGLE_CLIENT_SECRET, and Cloudinary keys
```

### 3. Start infrastructure

```bash
docker compose up -d postgres redis
```

### 4. Run migrations and seed

```bash
pnpm --filter @snaptrace/backend exec prisma migrate dev
npx tsx scripts/seed.ts
```

### 5. Start development servers

```bash
pnpm dev
```

| Service       | URL                          |
| ------------- | ---------------------------- |
| Backend API   | http://localhost:3000        |
| Dashboard     | http://localhost:3001        |
| Worker health | http://localhost:3002/health |
| Prisma Studio | http://localhost:5555        |

---

## Load Extension in Chrome

```bash
pnpm --filter @snaptrace/extension build
```

Then open `chrome://extensions` → enable **Developer mode** → click **Load unpacked** → select `apps/extension/dist/`.

---

## Seed Credentials

| Role  | Email               | Password             |
| ----- | ------------------- | -------------------- |
| Admin | admin@snaptrace.app | Admin@SnapTrace2024! |
| User  | demo@snaptrace.app  | User@SnapTrace2024!  |

---

## Environment Variables

| Variable                | Description                                         |
| ----------------------- | --------------------------------------------------- |
| `DATABASE_URL`          | PostgreSQL connection string (Prisma)               |
| `JWT_SECRET`            | Secret for signing JWT access tokens (min 64 chars) |
| `REDIS_URL`             | Redis connection URL                                |
| `CLOUDINARY_CLOUD_NAME` | Your Cloudinary cloud name                          |
| `CLOUDINARY_API_KEY`    | Cloudinary API key                                  |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret                               |
| `GOOGLE_CLIENT_ID`      | Google OAuth 2.0 client ID                          |
| `GOOGLE_CLIENT_SECRET`  | Google OAuth 2.0 client secret                      |
| `CORS_ORIGIN`           | Allowed CORS origin (e.g. `http://localhost:3001`)  |
| `PORT`                  | Backend HTTP port (default: `3000`)                 |
| `NODE_ENV`              | `development`, `test`, or `production`              |
| `VITE_API_URL`          | API URL baked into dashboard build                  |
| `VITE_WS_URL`           | WebSocket URL baked into dashboard build            |

---

## Commands

```bash
pnpm dev                                                      # Start all apps
pnpm build                                                    # Build all apps
pnpm lint                                                     # Lint all workspaces
pnpm type-check                                               # TypeScript check
pnpm test                                                     # Run all tests
pnpm format                                                   # Format with Prettier

pnpm --filter @snaptrace/backend exec prisma studio           # Open DB GUI
pnpm --filter @snaptrace/extension build                      # Build Chrome extension

docker compose up -d                                          # Start infra
docker compose logs -f backend                                # Stream backend logs

./scripts/setup.sh                                            # Full local bootstrap
./scripts/migrate.sh deploy                                   # Apply migrations
./scripts/migrate.sh studio                                   # Prisma Studio GUI
```

---

## Contributing

Contributions are welcome!

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit using [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: add recording annotation toolbar`
   - `fix: resolve upload chunk ordering bug`
   - `docs: update API reference`
4. Open a Pull Request — fill out the PR template with a summary and test plan

Code standards: TypeScript strict mode, ESLint + Prettier enforced in CI, Vitest for tests.

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

Built with Express, Prisma, React, Vite, FFmpeg, Socket.IO, Cloudinary, and Turborepo.
