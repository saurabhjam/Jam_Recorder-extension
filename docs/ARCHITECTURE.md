# Architecture

## System Overview

SnapTrace is a self-hosted screen recording platform built as a monorepo. It consists of three user-facing applications (Chrome extension, web dashboard, backend API) plus a background worker for video processing, all wired together through a shared PostgreSQL database, Redis queue, and Cloudinary CDN.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            USER / BROWSER                                   │
│                                                                             │
│   ┌──────────────────────┐          ┌──────────────────────────────────┐   │
│   │   Chrome Extension   │          │      Web Dashboard (SPA)         │   │
│   │ (@snaptrace/extension)│          │    (@snaptrace/dashboard)        │   │
│   │                      │          │                                  │   │
│   │  • Screen capture    │          │  • Recording list & playback     │   │
│   │  • Webcam overlay    │          │  • Team management               │   │
│   │  • Canvas annotation │          │  • Analytics                     │   │
│   │  • Chunked upload    │          │  • Sharing & comments            │   │
│   └──────────┬───────────┘          └──────────────┬───────────────────┘   │
│              │                                      │                       │
└──────────────┼──────────────────────────────────────┼───────────────────────┘
               │                                      │
               │ HTTPS / WebSocket                    │ HTTPS / WebSocket
               │                                      │
               ▼                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         Nginx Reverse Proxy                                  │
│                                                                              │
│   /api/*       → backend:5000     (REST API)                                │
│   /socket.io/* → backend:5000     (WebSocket real-time events)              │
│   /            → dashboard:80     (React SPA, static files)                 │
│                                                                              │
│   • Rate limiting (30 req/s API, 5 req/s upload)                           │
│   • SSL termination                                                          │
│   • Gzip compression                                                         │
│   • Client body limit: 500 MB                                               │
└──────────────────────────┬───────────────────────────────────────────────────┘
                           │
               ┌───────────┴──────────┐
               │                      │
               ▼                      ▼
┌──────────────────────┐  ┌──────────────────────┐
│   Backend API        │  │   Dashboard (Nginx)   │
│   (Express + TS)     │  │   (Nginx, static)     │
│                      │  │                       │
│  • REST API          │  │  • React SPA          │
│  • Socket.IO server  │  │  • Vite build output  │
│  • JWT auth          │  │  • SPA fallback       │
│  • Prisma ORM        │  └──────────────────────┘
│  • Multer uploads    │
│  • Job enqueue       │
└──────┬───────────────┘
       │
       │   reads/writes
       ├──────────────────────┐
       │                      │
       ▼                      ▼
┌─────────────┐       ┌──────────────┐
│  PostgreSQL │       │    Redis     │
│  (primary   │       │  (cache +    │
│   database) │       │   job queue) │
└─────────────┘       └──────┬───────┘
                              │  dequeues jobs
                              ▼
                   ┌──────────────────────┐
                   │   Background Worker  │
                   │                      │
                   │  • Video processing  │
                   │  • FFmpeg compress   │
                   │  • Thumbnail gen     │
                   │  • Cloudinary upload │
                   │  • Status updates    │
                   └──────────────────────┘
                              │
                              │ uploads processed media
                              ▼
                   ┌──────────────────────┐
                   │   Cloudinary CDN     │
                   │                      │
                   │  • Video storage     │
                   │  • Image storage     │
                   │  • Transformations   │
                   │  • Global delivery   │
                   └──────────────────────┘
```

---

## Component Descriptions

### Chrome Extension (`apps/extension`)

The recording entrypoint. Built with Vite + React + TypeScript.

| Component      | Responsibility                                         |
| -------------- | ------------------------------------------------------ |
| Background SW  | Manages `chrome.tabCapture`, recording lifecycle state |
| Content Script | Injects UI overlay, annotation canvas into active tab  |
| Popup          | Start/stop/annotate controls, recording status display |
| Sidepanel      | Full recording list, quick share                       |
| Upload Service | Chunked multipart upload to `/api/recordings/upload`   |

**Recording flow:**

1. User clicks "Record" in popup
2. Background SW requests `tabCapture` permission and starts `MediaRecorder`
3. Webcam stream (optional) is captured separately and composited client-side
4. On stop, chunks are assembled into a `Blob` and uploaded to the API
5. Backend enqueues a processing job; extension polls for status

### Backend API (`backend`)

Express.js application with TypeScript, Prisma ORM, Socket.IO.

| Module       | Responsibility                                            |
| ------------ | --------------------------------------------------------- |
| `auth`       | JWT-based register/login/refresh, bcrypt password hashing |
| `recordings` | CRUD, chunked upload handling, status management          |
| `sharing`    | Share-token generation, public/private access control     |
| `teams`      | Team creation, member invites, role management            |
| `users`      | Profile management, avatar upload                         |
| `websocket`  | Real-time processing status events via Socket.IO          |
| `queue`      | Redis-backed BullMQ job producer for video processing     |
| `health`     | `/health` endpoint for Docker/load balancer health checks |

### Background Worker (`docker/worker.Dockerfile`)

Runs a separate Node.js process that consumes from the Redis job queue.

**Processing pipeline per recording:**

1. Download raw video from temp storage
2. Validate format and duration
3. FFmpeg transcode to H.264/AAC MP4 (web-optimized)
4. Generate thumbnail (first frame or at 1s)
5. Upload video + thumbnail to Cloudinary
6. Update `recording.status = READY` and `videoUrl` in PostgreSQL
7. Emit `recording:ready` event via Socket.IO (through Redis pub/sub)

### Dashboard (`apps/dashboard`)

React SPA (Vite build) served by its own Nginx container.

| Page              | Responsibility                                   |
| ----------------- | ------------------------------------------------ |
| `/`               | Landing / redirect to recordings                 |
| `/recordings`     | List all recordings with filters, search, sort   |
| `/recordings/:id` | Video player, comments, annotations, share modal |
| `/teams`          | Team settings, member management, invite links   |
| `/settings`       | User profile, notification preferences           |

---

## Data Flow

### Upload Flow

```
Extension                Backend API              Worker              Cloudinary
    │                        │                      │                     │
    │── POST /upload/init ──►│                      │                     │
    │◄─ { uploadId }─────────│                      │                     │
    │                        │                      │                     │
    │── POST /upload/chunk ─►│ (stores temp chunk)  │                     │
    │── POST /upload/chunk ─►│                      │                     │
    │── POST /upload/chunk ─►│                      │                     │
    │                        │                      │                     │
    │── POST /upload/finish─►│                      │                     │
    │                        │── enqueue job ──────►│                     │
    │                        │                      │── upload raw ──────►│
    │                        │                      │── transcode         │
    │                        │                      │── gen thumbnail     │
    │                        │                      │◄─ secure_url ───────│
    │                        │◄─ status: READY ─────│                     │
    │◄── WS: ready event ────│                      │                     │
```

### Authentication Flow

```
Client                  Backend
  │                       │
  │── POST /auth/login ──►│
  │                       │── verify password (bcrypt)
  │                       │── sign JWT (7d expiry)
  │                       │── set refresh token (httpOnly cookie, 30d)
  │◄─ { accessToken } ────│
  │                       │
  │── GET /api/* ─────────│ (Authorization: Bearer <token>)
  │                       │── verify JWT middleware
  │◄─ response ───────────│
```

---

## Tech Stack Decisions

| Decision          | Choice           | Rationale                                                      |
| ----------------- | ---------------- | -------------------------------------------------------------- |
| Monorepo tooling  | Turborepo + pnpm | Efficient caching, parallel task execution, workspace hoisting |
| Backend framework | Express.js       | Minimal, fast, wide ecosystem, easy to extend                  |
| ORM               | Prisma           | Type-safe, migrations, great DX for TypeScript                 |
| Video storage     | Cloudinary       | Handles transcoding, global CDN, adaptive streaming            |
| Job queue         | Redis + BullMQ   | Reliable, persistent, observable job processing                |
| Real-time         | Socket.IO        | Handles WebSocket + polling fallback transparently             |
| Container runtime | Docker Compose   | Reproducible local dev + easy production deployment            |
| Reverse proxy     | Nginx            | Performant, stable, handles SSL termination                    |
| Frontend build    | Vite             | Fast HMR, excellent extension plugin ecosystem                 |
| UI styling        | Tailwind CSS     | Utility-first, consistent design system                        |

---

## Scaling Considerations

### Horizontal Scaling

The backend and worker are stateless (all state in PostgreSQL/Redis/Cloudinary):

- **Backend API**: Scale horizontally behind a load balancer. Socket.IO uses Redis adapter (`socket.io-redis`) to broadcast across instances.
- **Worker**: Scale worker replicas independently based on queue depth. BullMQ handles concurrent workers safely.
- **PostgreSQL**: Use read replicas for read-heavy workloads. Implement connection pooling with PgBouncer at scale.
- **Redis**: Use Redis Cluster or a managed service (ElastiCache, Redis Cloud) for high availability.

### Storage

- **Video files**: Cloudinary handles storage and CDN. No filesystem state on servers.
- **Temp upload chunks**: Written to `/app/uploads` (Docker volume). For multi-instance setups, replace with shared NFS or S3-compatible storage.

### Database

- Add indexes on `recordings.userId`, `recordings.teamId`, `recordings.status`, and `recordings.createdAt DESC` for the most common query patterns.
- Use `cursor-based pagination` (not offset) for the recordings list to avoid index degradation at scale.

### Estimated Resource Requirements (single server)

| Tier        | Users  | CPU     | RAM   | Storage        |
| ----------- | ------ | ------- | ----- | -------------- |
| Development | 1-5    | 2 vCPU  | 4 GB  | 20 GB          |
| Small team  | 5-50   | 4 vCPU  | 8 GB  | 100 GB         |
| Medium team | 50-500 | 8 vCPU  | 16 GB | 500 GB         |
| Enterprise  | 500+   | Cluster | —     | Object storage |
