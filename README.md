# SnapTrace

> Enterprise screen recording, bug reporting & async video platform — fully self-hosted.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178c6?logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![pnpm](https://img.shields.io/badge/pnpm-8.15-f69220?logo=pnpm)](https://pnpm.io)
[![Turborepo](https://img.shields.io/badge/Turborepo-monorepo-EF4444?logo=turborepo)](https://turbo.build)

---

## Table of Contents

1. [What is SnapTrace?](#what-is-snaptrace)
2. [Architecture Overview](#architecture-overview)
3. [Monorepo Structure](#monorepo-structure)
4. [Tech Stack](#tech-stack)
5. [Chrome Extension — Deep Dive](#chrome-extension--deep-dive)
6. [Backend API](#backend-api)
7. [Video Worker](#video-worker)
8. [Dashboard](#dashboard)
9. [Database Schema](#database-schema)
10. [Queue System](#queue-system)
11. [Video Storage — External API (ReportPortal)](#video-storage--external-api-reportportal)
12. [Data Capture Pipeline](#data-capture-pipeline)
13. [Recording Lifecycle](#recording-lifecycle)
14. [Upload Pipeline](#upload-pipeline)
15. [Authentication](#authentication)
16. [Infrastructure & Docker](#infrastructure--docker)
17. [Environment Variables](#environment-variables)
18. [API Reference](#api-reference)
19. [Keyboard Shortcuts](#keyboard-shortcuts)
20. [Known Limitations](#known-limitations)
21. [Complete Setup Guide — New Laptop / New Device](#complete-setup-guide--new-laptop--new-device)

---

## What is SnapTrace?

SnapTrace is a **self-hosted, open-source screen recording and bug reporting platform** built for engineering and product teams. It captures full-screen or tab recordings with synchronized console logs, network requests, and user actions — then shares them instantly via a public link.

**Key differentiators:**

- **Zero-install sharing** — Recipients need no extension; recordings stream from a public URL.
- **Deep browser instrumentation** — Records console logs and network requests using Chrome DevTools Protocol (CDP), not just screen pixels.
- **Offline-first upload** — Chunks are stored in IndexedDB; incomplete uploads resume automatically when connectivity returns.
- **Service worker resilient** — All recording state survives Chrome's MV3 service worker suspension via `chrome.storage.session` and `chrome.storage.local`.
- **External portal integration** — Every recording is automatically synced to a ReportPortal instance for centralized access.
- **Fully self-hosted** — All data stays on your infrastructure. No external analytics or tracking.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Chrome Extension (MV3)                      │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Popup UI   │  │   Content    │  │  Offscreen Document  │  │
│  │  (React SPA) │  │   Script     │  │  (MediaRecorder,     │  │
│  │              │  │  (toolbar,   │  │   AudioContext,       │  │
│  │              │  │   capture)   │  │   IndexedDB upload)  │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                 │                      │              │
│         └────────┬────────┘                      │              │
│                  ▼                               │              │
│         ┌────────────────────────────────────────────────┐      │
│         │         Background Service Worker              │      │
│         │  (CDP, state, auth, toolbar injection)         │      │
│         └──────────────────┬───────────────────────────  ┘      │
└──────────────────────────────────────────────────────────────── ┘
                              │ HTTP (port 4000)
               ┌──────────────▼──────────────┐
               │         Backend API          │
               │  Node.js + Express + Prisma  │
               │       localhost:4000         │
               └──────┬─────────────┬─────────┘
                      │             │
         ┌────────────▼──┐   ┌──────▼────────────┐
         │  PostgreSQL   │   │  Redis + BullMQ   │
         │  (port 5432)  │   │  (port 6379)      │
         └───────────────┘   └──────┬────────────┘
                                    │ job queue
                           ┌────────▼──────────┐
                           │   Video Worker    │
                           │  (FFmpeg + Node)  │
                           │  → Cloudinary     │
                           └───────────────────┘
               ┌──────────────────────────────────┐
               │      Dashboard  (React SPA)       │
               │         localhost:3001            │
               │  Share page, library, analytics   │
               └──────────────────────────────────┘
               ┌──────────────────────────────────┐
               │   External Portal (ReportPortal) │
               │         localhost:3000            │
               │  Video file storage + records     │
               └──────────────────────────────────┘
```

---

## Monorepo Structure

```
Jam_Recorder-extension/
├── apps/
│   ├── extension/          Chrome Extension (MV3, React + TypeScript)
│   ├── backend/            Express API (Node.js 18, Prisma, BullMQ)  port 4000
│   ├── worker/             Video processing worker (FFmpeg, BullMQ)  port 3002 (health)
│   └── dashboard/          Web dashboard (React + Vite)              port 3001
├── packages/
│   ├── types/              Shared TypeScript types
│   ├── config/             Shared constants (queue names, TTLs)
│   ├── tsconfig/           Shared TypeScript configs
│   ├── eslint-config/      Shared ESLint ruleset
│   └── ui/                 Shared React components
├── docker/
│   ├── backend.Dockerfile
│   ├── worker.Dockerfile
│   └── dashboard.Dockerfile
├── docker-compose.yml
├── turbo.json              Turborepo pipeline config
└── pnpm-workspace.yaml
```

**Build system:** [Turborepo](https://turbo.build) with task caching.
**Package manager:** pnpm 8.15 workspaces.

---

## Tech Stack

### Summary

| Layer                  | . Technology                                                  |
| ---------------------- | ------------------------------------------------------------- |
| **Backend**            | Node.js + Express + TypeScript                                |
| **Database**           | PostgreSQL (via Prisma ORM)                                   |
| **Cache / Sessions**.  | Redis (via IORedis)                                           |
| **Job Queue**          | BullMQ (runs on Redis)                                        |
| **Background Workers** | Separate `worker` app (BullMQ consumers)                      |
| **File Storage**       | Cloudinary (video/images) — falls back to LocalStorage in dev |
| **Auth**               | JWT (access + refresh tokens) + Google OAuth (Passport.js)    |
| **Email**              | Nodemailer (Gmail SMTP)                                       |
| **Real-time**          | Socket.IO                                                     |
| **External CRM**       | ReportPortal-style API (OAuth2 password grant)                |
| **Frontend**           | React + Vite + Tailwind (dashboard on port 3001)              |
| **Extension**          | Chrome Extension (Manifest V3, built with Vite)               |

---

### Backend (`apps/backend`)

| Package                                | Purpose                                                 |
| -------------------------------------- | ------------------------------------------------------- |
| `express`                              | HTTP server framework                                   |
| `helmet`                               | Security headers                                        |
| `cors`                                 | Cross-origin request handling                           |
| `compression`                          | Gzip response compression                               |
| `cookie-parser`                        | Cookie parsing                                          |
| `morgan`                               | HTTP request logging                                    |
| `express-rate-limit`                   | API rate limiting                                       |
| `multer`                               | Multipart file upload (chunk uploads)                   |
| `jsonwebtoken`                         | JWT sign/verify (access + refresh tokens)               |
| `bcryptjs`                             | Password hashing (12 rounds)                            |
| `passport` + `passport-google-oauth20` | Google OAuth2 login                                     |
| `@prisma/client` + `prisma`            | PostgreSQL ORM + migrations                             |
| `ioredis`                              | Redis client (sessions, upload progress cache)          |
| `bullmq`                               | Job queue (runs on Redis)                               |
| `cloudinary`                           | Cloud storage (exists in code, not used in upload flow) |
| `socket.io`                            | Real-time events (recording status, notifications)      |
| `nodemailer`                           | Email via Gmail SMTP                                    |
| `zod`                                  | Request body validation                                 |
| `nanoid`                               | Short unique ID generation                              |
| `dotenv`                               | Environment variable loading                            |
| `ts-node-dev`                          | TypeScript dev server with hot-reload                   |
| `vitest` + `supertest`                 | Unit + integration testing                              |

### Worker (`apps/worker`)

| Package          | Purpose                                  |
| ---------------- | ---------------------------------------- |
| `bullmq`         | BullMQ job consumer                      |
| `ioredis`        | Redis connection                         |
| `fluent-ffmpeg`  | Video transcoding + thumbnail extraction |
| `@prisma/client` | DB access (update recording status)      |
| `cloudinary`     | Upload processed video                   |
| `axios`          | HTTP calls                               |
| `winston`        | Structured logging                       |

### Dashboard (`apps/dashboard`)

| Package                   | Purpose                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `react` + `react-dom`     | UI framework                                                                         |
| `react-router-dom`        | Client-side routing                                                                  |
| `@tanstack/react-query`   | Server state, caching, loading/error states                                          |
| `zustand`                 | Client-side state management                                                         |
| `axios`                   | API calls to backend                                                                 |
| `framer-motion`           | Animations                                                                           |
| `recharts`                | Charts (analytics)                                                                   |
| `lucide-react`            | Icons                                                                                |
| `tailwindcss`             | Utility CSS styling                                                                  |
| `clsx` + `tailwind-merge` | Conditional className merging                                                        |
| `react-hot-toast`         | Toast notifications                                                                  |
| `@radix-ui/*`             | Accessible UI primitives (Dialog, Dropdown, Tabs, Tooltip, Avatar, Progress, Switch) |

### Extension (`apps/extension`)

| Package                              | Purpose                                    |
| ------------------------------------ | ------------------------------------------ |
| `react` + `react-dom`                | Popup UI                                   |
| `@tanstack/react-query`              | API data fetching                          |
| `zustand`                            | Auth + recording state                     |
| `axios`                              | Backend API calls                          |
| `framer-motion`                      | Popup animations                           |
| `fabric`                             | Canvas annotation tool                     |
| `lucide-react`                       | Icons                                      |
| `tailwindcss`                        | Styling                                    |
| `nanoid`                             | Unique IDs                                 |
| `vite` + `vite-plugin-web-extension` | Builds Manifest V3 Chrome extension        |
| `@types/chrome`                      | TypeScript types for Chrome extension APIs |

---

## Chrome Extension — Deep Dive

### Manifest V3

The extension targets **Manifest V3** — Chrome's current extension platform.

```json
{
  "manifest_version": 3,
  "name": "SnapTrace Recorder",
  "version": "1.0.0",
  "permissions": [
    "storage",
    "tabs",
    "scripting",
    "tabCapture",
    "desktopCapture",
    "offscreen",
    "activeTab",
    "downloads",
    "windows",
    "debugger",
    "webNavigation"
  ],
  "host_permissions": ["<all_urls>"]
}
```

**Permission breakdown:**

| Permission       | Why it is needed                                                                  |
| ---------------- | --------------------------------------------------------------------------------- |
| `storage`        | Persist recording state, auth tokens, and offline upload queue across SW restarts |
| `tabs`           | Detect OAuth callback URL; query the active tab for toolbar injection             |
| `scripting`      | Inject content scripts programmatically; inject the main-world capture function   |
| `tabCapture`     | Capture audio + video from a specific browser tab                                 |
| `desktopCapture` | Full-screen capture via the native OS picker                                      |
| `offscreen`      | Create a hidden document with access to `MediaRecorder` and `getUserMedia`        |
| `activeTab`      | Access the focused tab without broad host permission prompts                      |
| `downloads`      | Save screenshots to disk                                                          |
| `windows`        | Open the post-recording editor as a popup window                                  |
| `debugger`       | Attach Chrome DevTools Protocol to intercept network + console events             |
| `webNavigation`  | Detect SPA route changes so the toolbar is re-injected after navigation           |

---

### Extension Processes

Four distinct JS contexts communicate via `chrome.runtime.sendMessage`:

```
Popup UI             ──────────────────────────────────┐
Content Script (tab) ──────────────────────────────────┤
Editor Window        ──────────────────────────────────┼──► Background Service Worker
Offscreen Document   ──────────────────────────────────┘         (orchestrator)
```

---

### 1. Background Service Worker (`src/background/index.ts`)

The central orchestrator. Manages everything that requires cross-context coordination.

**Responsibilities:**

- Auth lifecycle (token refresh via `chrome.alarms` — survives SW suspension)
- Recording state machine (idle → recording → stopping → done)
- CDP debugger attach / detach / re-attach on navigation
- Main-world capture script injection (CSP bypass)
- Floating toolbar lifecycle and automatic re-injection
- Badge text + color management
- Relay messages between popup ↔ offscreen ↔ content scripts
- Offline queue processing on browser startup
- OAuth callback interception via `chrome.tabs.onUpdated`
- Full state restoration from persistent storage on every SW wake-up

**Key functions:**

| Function                              | Purpose                                                      |
| ------------------------------------- | ------------------------------------------------------------ |
| `sendToOffscreen(type, payload)`      | Retry-safe message to offscreen (5 attempts, 250ms backoff)  |
| `handleStartRecording(options, cb)`   | Gets stream ID, instructs offscreen, attaches CDP            |
| `handleStopRecording(cb, cancel)`     | Flushes captures, merges sources, opens editor               |
| `attachDebugger(tabId)`               | Attaches CDP; enables Network + Runtime + Log domains        |
| `reattachDebugger(tabId)`             | Re-attaches after navigation WITHOUT clearing captures       |
| `injectMainWorldCaptureScript(tabId)` | Runs `captureScriptMain` in the page's MAIN world            |
| `reinjectToolbarIntoTab(tabId)`       | Called on every navigation; re-attaches CDP + toolbar        |
| `restoreStateFromStorage()`           | Reads both storage layers; restores in-memory state + CDP    |
| `scheduleCaptureFlush()`              | Debounced 2s write of CDP arrays to `chrome.storage.session` |

---

#### Service Worker Suspension Resilience

MV3 service workers are terminated by Chrome after ~30 seconds of inactivity. SnapTrace uses a two-layer persistence strategy:

```
chrome.storage.local   → recording metadata (isRecording, recordingId, tabId, startedAt, options)
chrome.storage.session → CDP captures (consoleLogs[], networkEntries[])
                         survives SW suspension within the same browser session
```

CDP captures are flushed to session storage at most every **2 seconds** (debounced) — so at most 2 seconds of events are lost if Chrome kills the SW mid-recording.

---

### 2. Content Script (`src/content/index.ts`)

Injected at `document_start` into every browser tab.

**Responsibilities:**

- Mount and unmount the floating recording toolbar (React, Shadow DOM isolated)
- Mount the annotation canvas overlay
- Listen for background messages: `SHOW_TOOLBAR`, `HIDE_TOOLBAR`, `CAPTURE_FLUSH`, `UPDATE_TIMER`
- Back-up network/console capture via XHR/fetch interception and console patching
- Relay accumulated data to background on `CAPTURE_FLUSH`

**Why two capture layers (CDP + content script)?**

CDP is authoritative but has coverage gaps:

- Auto-detaches on cross-origin navigation (brief gap while re-attaching)
- May miss events that fire before the debugger is attached

The content script fills those gaps. On stop, both datasets are merged with **500ms bucket deduplication** — CDP entries always win.

---

### 3. Main-World Capture (`captureScriptMain`)

Injected by the background into the **page's main JavaScript execution context** via `chrome.scripting.executeScript({ world: 'MAIN' })`. Running in MAIN world bypasses any Content Security Policy on the page.

**Patches four browser APIs:**

| API                                     | How                                             | Data captured                                  |
| --------------------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| `XMLHttpRequest`                        | Wraps `open()` + `send()`; listens to `loadend` | URL, method, status, duration, size            |
| `window.fetch`                          | Wraps with `.then()` + `.clone().arrayBuffer()` | URL, method, status, duration, byteLength      |
| `console.*`                             | Wraps `log`, `info`, `warn`, `error`, `debug`   | level, joined args, timestamp, `location.href` |
| `window.onerror` + `unhandledrejection` | Adds listeners                                  | error/rejection message, timestamp             |

All data is posted via `window.postMessage({ __st: true, ...data }, '*')` and received by the content script.

---

### 4. Offscreen Document (`src/offscreen/`)

A hidden HTML page with access to APIs unavailable in service workers: `getUserMedia`, `MediaRecorder`, `AudioContext`, `createObjectURL`, `IndexedDB`.

| Task               | Detail                                                                 |
| ------------------ | ---------------------------------------------------------------------- |
| Stream acquisition | `tabCapture.getMediaStreamId` + `getUserMedia` for webcam/mic          |
| Audio mixing       | `AudioContext` combines system audio + microphone + webcam audio       |
| Video recording    | `MediaRecorder` collects Blobs every ~1s                               |
| Thumbnail          | First frame drawn to `<canvas>` → `toDataURL('image/jpeg', 0.85)`      |
| Blob persistence   | Written to IndexedDB (`snaptrace-recordings` DB)                       |
| Chunked upload     | Splits blob into 2MB chunks; uploads sequentially                      |
| Offline queue      | Stores incomplete uploads in IndexedDB; resumes on next extension load |

**Message protocol (offscreen ↔ background):**

```
background → offscreen:
  OFFSCREEN_START_RECORDING  { options, streamId, recordingId }
  OFFSCREEN_STOP_RECORDING   { recordingId, title, type, duration, quality, ... }
  OFFSCREEN_PAUSE_RECORDING
  OFFSCREEN_RESUME_RECORDING
  OFFSCREEN_TAKE_SCREENSHOT  { streamId }
  OFFSCREEN_PROCESS_QUEUE    (resume offline uploads)

offscreen → background:
  OFFSCREEN_RECORDING_READY  { thumbnailDataUrl, duration, blobSize, recordingId, title }
  OFFSCREEN_UPLOAD_PROGRESS  { percent, uploadedChunks, totalChunks }
  OFFSCREEN_UPLOAD_COMPLETE  { shareUrl, recordingId }
  OFFSCREEN_ERROR            { error }
```

---

### 5. Popup UI (`src/popup/views/`)

React SPA rendered in the browser action popup (380×580px).

| View             | Purpose                                                    |
| ---------------- | ---------------------------------------------------------- |
| `LoginView`      | Email/password login or Google OAuth                       |
| `HomeView`       | Recording type selector (screen / tab / webcam) + settings |
| `RecordingView`  | Live controls: pause, resume, screenshot, stop, timer      |
| `AnnotationView` | Drawing tool palette usable during recording               |
| `BugReportView`  | Bug title, severity, steps-to-reproduce capture            |
| `UploadView`     | Chunked upload progress bar                                |
| `ShareView`      | Copy share link after upload completes                     |
| `LibraryView`    | Paginated past recordings with search                      |
| `SettingsView`   | Quality presets, hotkeys, mic/webcam defaults, theme       |

---

### Storage Keys Reference

| Key                  | Storage   | Contents                                                  |
| -------------------- | --------- | --------------------------------------------------------- |
| `st_recording_state` | `local`   | `{ isRecording, recordingId, options, startedAt, tabId }` |
| `st_cdp_captures`    | `session` | `{ consoleLogs[], networkEntries[] }` — cleared on stop   |
| `st_auth_tokens`     | `local`   | `{ accessToken, refreshToken, expiresAt }`                |
| `st_auth_user`       | `local`   | User profile object                                       |
| `st_settings`        | `local`   | `ExtensionSettings` (quality, mic, hotkeys, theme)        |
| `st_offline_queue`   | `local`   | Recordings waiting for upload                             |
| `st_pending_share`   | `local`   | `{ shareUrl, recordingId }` — last completed upload       |
| `st_editor_data`     | `local`   | Capture payload passed to editor window                   |

---

### Quality Presets

| Preset   | Resolution | FPS | Video Bitrate |
| -------- | ---------- | --- | ------------- |
| `low`    | 1280×720   | 24  | 1 Mbps        |
| `medium` | 1920×1080  | 30  | 2.5 Mbps      |
| `high`   | 1920×1080  | 60  | 5 Mbps        |
| `4k`     | 3840×2160  | 30  | 15 Mbps       |

---

## Backend API

**Runtime:** Node.js 18+ with Express 4
**ORM:** Prisma 5
**Auth:** JWT (30m access + 10d refresh)
**Port:** `4000`
**Base URL:** `http://localhost:4000/api`

### Auth — `/api/auth`

| Method | Path               | Auth     | Description                            |
| ------ | ------------------ | -------- | -------------------------------------- |
| `POST` | `/register`        | None     | Create account                         |
| `POST` | `/login`           | None     | Email + password login                 |
| `POST` | `/refresh`         | None     | Refresh access token via refresh token |
| `POST` | `/logout`          | Required | Revoke current or all sessions         |
| `GET`  | `/me`              | Required | Get current user profile               |
| `PUT`  | `/me`              | Required | Update profile name / avatar           |
| `POST` | `/forgot-password` | None     | Send password reset email              |
| `POST` | `/reset-password`  | None     | Confirm reset with token               |
| `GET`  | `/google`          | None     | Redirect to Google OAuth consent       |
| `GET`  | `/google/callback` | None     | OAuth callback → redirect with tokens  |

### Recordings — `/api/recordings`

| Method   | Path               | Auth     | Description                                            |
| -------- | ------------------ | -------- | ------------------------------------------------------ |
| `GET`    | `/`                | Required | List recordings (paginated, search, filter)            |
| `POST`   | `/`                | Required | Create recording row (before upload)                   |
| `GET`    | `/stream/:shareId` | None     | Proxy video stream from External API (adds auth token) |
| `GET`    | `/share/:shareId`  | Optional | Get public recording by shareId                        |
| `GET`    | `/:id`             | Required | Get single recording                                   |
| `PUT`    | `/:id`             | Required | Update title, description, visibility                  |
| `DELETE` | `/:id`             | Required | Delete recording                                       |
| `POST`   | `/:id/view`        | Optional | Increment view counter                                 |
| `GET`    | `/:id/analytics`   | Required | Views, visitors, event breakdown                       |
| `POST`   | `/:id/reprocess`   | Required | Re-queue a stuck recording                             |

### Uploads — `/api/uploads`

| Method   | Path                     | Description                                                     |
| -------- | ------------------------ | --------------------------------------------------------------- |
| `POST`   | `/initiate`              | Begin chunked upload session (stores state in Redis)            |
| `POST`   | `/chunk`                 | Upload one 2MB chunk                                            |
| `GET`    | `/progress/:recordingId` | Poll upload progress from Redis                                 |
| `POST`   | `/complete/:recordingId` | Assemble chunks → upload to External API → create portal record |
| `DELETE` | `/abort/:recordingId`    | Cancel and clean up temp chunks                                 |

### Comments — `/api/recordings/:id/comments`

| Method   | Path          | Description                                    |
| -------- | ------------- | ---------------------------------------------- |
| `GET`    | `/`           | List comments (threaded)                       |
| `POST`   | `/`           | Create comment with optional video `timestamp` |
| `PUT`    | `/:commentId` | Edit comment                                   |
| `DELETE` | `/:commentId` | Delete comment                                 |

### Reactions — `/api/recordings/:id/reactions`

| Method | Path | Description                                    |
| ------ | ---- | ---------------------------------------------- |
| `GET`  | `/`  | Get reaction counts + current user's reactions |
| `POST` | `/`  | Toggle emoji reaction (add or remove)          |

### Shares — `/api/shares`

| Method   | Path                      | Description                                    |
| -------- | ------------------------- | ---------------------------------------------- |
| `POST`   | `/`                       | Create share link (optional password + expiry) |
| `GET`    | `/recording/:recordingId` | List share links for a recording               |
| `GET`    | `/:token`                 | Resolve share link → get recording             |
| `DELETE` | `/:token`                 | Revoke share link                              |

### Teams — `/api/teams`

| Method   | Path                    | Description             |
| -------- | ----------------------- | ----------------------- |
| `POST`   | `/`                     | Create team             |
| `GET`    | `/me`                   | Get current user's team |
| `GET`    | `/recordings`           | List team recordings    |
| `POST`   | `/invite`               | Send invite by email    |
| `POST`   | `/invite/accept`        | Accept invite via token |
| `DELETE` | `/members/:userId`      | Remove member           |
| `PUT`    | `/members/:userId/role` | Change member role      |

---

## Video Worker

**Queue library:** BullMQ
**Video processing:** FFmpeg via `fluent-ffmpeg`
**Cloud storage:** Cloudinary
**Concurrency:** 3 jobs in parallel (configurable via `WORKER_CONCURRENCY`)
**Health port:** 3002

### Processing Steps

```
BullMQ dequeues VideoProcessingJob
  │
  ├── 1.  Create temp dir: /tmp/jam-worker/rec_<id>_<ts>/
  ├── 2.  Set recording status → PROCESSING
  ├── 3.  Fetch all UploadChunk URLs from DB (ordered by index)
  ├── 4.  Download all chunks
  │
  ├── 5.  Check FFmpeg
  │         ├── [Available]
  │         │     ├── Merge .webm chunks → merged.webm
  │         │     ├── Get video metadata (duration, resolution, fps)
  │         │     ├── Transcode to .mp4 (H.264, AAC, ≤1080p)
  │         │     └── Get final metadata
  │         │
  │         └── [Not available — fallback]
  │               └── Buffer.concat(chunks) → recording.webm
  │
  ├── 6.  Upload final video to Cloudinary
  │         folder: jam-recordings/<userId>/
  │         publicId: rec_<recordingId>
  │
  ├── 7.  Update recording → READY
  │         url, duration, size, mimeType
  │
  ├── 8.  Enqueue ThumbnailJob
  ├── 9.  Enqueue NotificationJob ("Recording ready")
  └── 10. Cleanup temp dir
```

**Retry policy:** 3 attempts, exponential backoff (2s, 4s, 8s). On final failure: status → `FAILED`.

---

## Dashboard

**Framework:** React 18 + Vite
**Routing:** React Router v6
**Server state:** React Query 5
**Client state:** Zustand
**Styling:** Tailwind CSS + Framer Motion
**Port:** 3001

### Pages

| Page                 | Route              | Description                      |
| -------------------- | ------------------ | -------------------------------- |
| `LoginPage`          | `/login`           | Email/password login             |
| `RegisterPage`       | `/register`        | Account creation                 |
| `ForgotPasswordPage` | `/forgot-password` | Password reset request           |
| `ResetPasswordPage`  | `/reset-password`  | Password reset confirmation      |
| `AuthCallbackPage`   | `/auth/callback`   | Google OAuth token exchange      |
| `DashboardPage`      | `/`                | Home — recent recordings + stats |
| `LibraryPage`        | `/library`         | Full library with search/filter  |
| `SharePage`          | `/share/:shareId`  | Public recording viewer          |
| `AnalyticsPage`      | `/analytics/:id`   | Views, unique visitors, timeline |
| `SettingsPage`       | `/settings`        | Account + notification settings  |
| `TeamPage`           | `/team`            | Team management + invites        |
| `BillingPage`        | `/billing`         | Plan + subscription              |

### Share Page

The share page (`/share/:shareId`) shows: video player + Console / Network / Actions / Backend log tabs.

- Video is served via the backend stream proxy (`/api/recordings/stream/:shareId`) — the backend adds the ReportPortal auth token transparently so the browser needs no credentials.
- Clicking a log entry seeks the video to that timestamp.
- Supports emoji reactions and timestamped comments (including guest comments with a name).

---

## Database Schema

**Database:** PostgreSQL 15
**ORM:** Prisma 5
**Connection:** `postgresql://jam:jampassword@localhost:5432/jamdb`

### Tables

| Table           | Purpose                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `User`          | Accounts — email, bcrypt password, Google OAuth, avatar, team membership                           |
| `Session`       | Refresh token store — one row per active device/login                                              |
| `Team`          | Workspace — FREE/PRO/TEAM/ENTERPRISE plans, slug, logo                                             |
| `TeamInvite`    | Pending email invitations with token + expiry                                                      |
| `Recording`     | Core entity — title, type, status, url (External API file URL), consoleLogs JSON, networkLogs JSON |
| `UploadChunk`   | Tracks each uploaded chunk (index, size, checksum, cloudUrl)                                       |
| `ShareLink`     | Public share tokens with optional password + expiry                                                |
| `Comment`       | Timestamped comments on recordings (supports guests + nested replies)                              |
| `Reaction`      | Emoji reactions per recording, per user or visitor                                                 |
| `Analytics`     | View/share events — visitorId, IP, userAgent, referer                                              |
| `Notification`  | In-app alerts (recording ready, comment, team invite, share viewed)                                |
| `ActivityLog`   | Audit trail — every user action with IP + userAgent                                                |
| `PasswordReset` | Time-limited reset tokens                                                                          |

### Key Fields — `Recording`

```
id            String   @id @default(cuid())
title         String
userId        String   → User
teamId        String?  → Team
status        UPLOADING | PROCESSING | READY | FAILED
type          SCREEN | TAB | WEBCAM | SCREENSHOT
url           String?  ← External API file URL (set after finalize)
shareId       String   @unique  ← used in public share links
isPublic      Boolean
allowDownload Boolean
viewCount     Int
metadata      Json?    ← browser, OS, viewport info
consoleLogs   Json?    ← array of console log entries
networkLogs   Json?    ← array of network request entries
size          BigInt?  ← bytes (serialized as string in JSON responses)
duration      Int?     ← seconds
```

### Enums

```
RecordingStatus:  UPLOADING | PROCESSING | READY | FAILED
RecordingType:    SCREEN | TAB | WEBCAM | SCREENSHOT
Role:             OWNER | ADMIN | MEMBER | VIEWER
Plan:             FREE | PRO | TEAM | ENTERPRISE
NotificationType: RECORDING_READY | COMMENT | TEAM_INVITE | SHARE_VIEWED
```

---

## Queue System

**Library:** BullMQ 5
**Backend:** Redis 7 (AOF persistence, 256MB maxmemory, `allkeys-lru`)

### Queues

| Queue name             | Job type             | Attempts | Backoff         |
| ---------------------- | -------------------- | -------- | --------------- |
| `video-processing`     | `VideoProcessingJob` | 3        | Exponential, 2s |
| `thumbnail-generation` | `ThumbnailJob`       | 3        | Exponential, 1s |
| `notifications`        | `NotificationJob`    | 3        | Exponential, 1s |
| `analytics`            | `AnalyticsJob`       | 2        | Fixed, 1s       |

### Job Data Shapes

```typescript
VideoProcessingJob  { recordingId, userId, mimeType, totalChunks }
ThumbnailJob        { recordingId, videoUrl }
NotificationJob     { userId, type, title, message, metadata? }
AnalyticsJob        { event, recordingId, userId?, visitorId?, ip?, userAgent?, referer? }
```

### Redis Usage

| Purpose         | What's stored                                                               |
| --------------- | --------------------------------------------------------------------------- |
| Upload sessions | `{ uploadId, totalChunks, uploadedChunks, status }` per recording — TTL 24h |
| Auth cache      | Cached user profile for fast `/auth/me`                                     |
| BullMQ queues   | All 4 queue job data                                                        |

---

## Video Storage — External API (ReportPortal)

Videos are **not** stored in Cloudinary during the upload flow. The actual video bytes go to a **ReportPortal** instance running at `EXTERNAL_API_BASE_URL` (default `http://localhost:3000`).

### How It Works

```
Chunks on disk (temp) → merged into single buffer
         │
         ▼
POST /api/v1/superadmin_personal/files/upload   ← actual video bytes go here
         │
         │  returns fileRef (filename or URL)
         ▼
fileUrl = http://localhost:3000/api/v1/superadmin_personal/files/<fileRef>
         │
         ▼
POST /api/v1/superadmin_personal/records        ← metadata + fileUrl registered in portal
         │
         ▼
prisma.recording.update({ url: fileUrl })       ← local DB stores the URL reference only
```

### Authentication

The backend auto-authenticates to ReportPortal via **OAuth2 password grant**:

```
POST /uat/sso/oauth/token
  grant_type=password
  username=superadmin
  password=your-portal-password
  Authorization: Basic dWk6dWltYW4=   ← base64("ui:uiman") — ReportPortal's UI client
```

The JWT is cached in memory and auto-refreshed 60 seconds before expiry — no manual token management needed.

### Video Proxy

Because ReportPortal files require a Bearer token, the browser cannot fetch them directly. The backend exposes a proxy endpoint:

```
GET /api/recordings/stream/:shareId
  → backend adds Authorization: Bearer <reportportal_token>
  → forwards Range headers (for video seeking)
  → streams response back to browser
```

The share page always receives a proxied URL like `http://localhost:4000/api/recordings/stream/<shareId>` — never the raw ReportPortal URL.

### Required for Video to Work

ReportPortal **must be running** at `EXTERNAL_API_BASE_URL` on every machine that runs the backend. Without it:

- Upload finalize will fail with `502 EXTERNAL_UPLOAD_FAILED`
- The share page video will not play

---

## Data Capture Pipeline

```
Recording starts
  ├── Background attaches CDP to tab
  │     Network.enable + Runtime.enable + Log.enable
  │
  └── Background injects captureScriptMain() into MAIN world
        Patches: XHR, fetch, console.*, onerror, unhandledrejection

During recording (continuous):
  ├── CDP events → background memory arrays
  │     cdpConsoleLogs[]  +  cdpNetworkEntries[]
  │     Flushed to chrome.storage.session every 2s (debounced)
  │
  └── Content script → consoleLogs[]  +  networkCaptures[]

On stop:
  ├── CAPTURE_FLUSH → content script returns its arrays
  ├── Detach CDP debugger
  ├── Merge both sources:
  │     CDP wins. Content-script entry added only if no matching CDP entry
  │     within ±500ms window (keyed by level|message|timestamp bucket)
  └── pendingCaptureData → written to chrome.storage.local [EDITOR_DATA]
                        → shown in editor + uploaded as recording.metadata
```

### CDP Events Captured

**Network domain:**

| Event                       | Fields recorded                                |
| --------------------------- | ---------------------------------------------- |
| `Network.requestWillBeSent` | `url`, `method`, `initiator.type`, `timestamp` |
| `Network.responseReceived`  | `status`, `statusText`, `mimeType`             |
| `Network.loadingFinished`   | `encodedDataLength` (size), total duration     |
| `Network.loadingFailed`     | `errorText`, duration                          |

**Runtime domain:**

| Event                      | Fields recorded                          |
| -------------------------- | ---------------------------------------- |
| `Runtime.consoleAPICalled` | `type` (level), args joined to string    |
| `Runtime.exceptionThrown`  | `exceptionDetails.exception.description` |

---

## Recording Lifecycle

```
idle
  │ User clicks Record (or Cmd+Shift+R)
  ▼
requesting
  │ handleStartRecording()
  │ → Acquire stream ID (tabCapture / desktopCapture)
  │ → ensureOffscreenDocument()
  │ → OFFSCREEN_START_RECORDING
  │ → attachDebugger(tabId)
  │ → injectMainWorldCaptureScript(tabId)
  │ → Persist to chrome.storage.local
  ▼
recording  [badge: REC 🔴, timer counting]
  │
  ├── Pause  → OFFSCREEN_PAUSE_RECORDING  [badge: || 🟡]
  ├── Resume → OFFSCREEN_RESUME_RECORDING [badge: REC 🔴]
  ├── Screenshot → OFFSCREEN_TAKE_SCREENSHOT
  ├── Navigation → reattachDebugger() + reinjectToolbar()
  └── SW suspension → transparently restored on next wake-up
  │
  │ User clicks Stop (or Cmd+Shift+S)
  ▼
stopping
  │ handleStopRecording()
  │ → CAPTURE_FLUSH to content script
  │ → detachDebugger()
  │ → Merge CDP + content-script captures
  │ → stopTimer() + clearBadge() + hideToolbar()
  │ → Remove state from chrome.storage.local + session
  │ → OFFSCREEN_STOP_RECORDING
  ▼
editor open  [960×680px popup window]
  │ Offscreen finalizes blob + generates thumbnail
  │ → OFFSCREEN_RECORDING_READY → background opens editor window
  │ → User edits title, reviews logs, clicks Upload
  ▼
uploading
  │ Chunked upload to backend (2MB chunks)
  │ → OFFSCREEN_UPLOAD_COMPLETE
  ▼
done
  Share URL on clipboard, popup shows share view
```

---

## Upload Pipeline

### Chunked Upload Detail (3-Phase Protocol)

```
Offscreen reads blob from IndexedDB
  │
  ├── Phase 1: POST /api/recordings
  │     { title, type, totalChunks, mimeType } → { recordingId }
  │
  ├── Phase 2: POST /api/uploads/initiate
  │     { recordingId, totalChunks } → { uploadId }
  │     Redis: stores UploadSession { uploadId, totalChunks, uploadedChunks: 0 }
  │
  ├── Phase 3: For each 2MB chunk:
  │     POST /api/uploads/chunk?recordingId=...&chunkIndex=...&totalChunks=...
  │     multipart body: { chunk (binary blob) }
  │     → Backend saves chunk to /tmp/snaptrace-uploads/<recordingId>/chunk_<i>
  │     → Upsert UploadChunk row in DB
  │     → Increment counter in Redis
  │
  └── Phase 4: POST /api/uploads/complete/:recordingId
        → Verify all chunk files exist on disk
        → Buffer.concat(all chunks) → merged buffer
        → Upload merged buffer to ReportPortal files API → get fileUrl
        → POST to ReportPortal records API → get externalId
        → prisma.recording.update({ status: READY, url: fileUrl })
        → Delete temp chunk files + Redis session
        → Return { shareUrl: http://localhost:3001/share/<shareId> }
```

### Offline Queue

If upload is interrupted, chunks already saved to disk are preserved. The offscreen document stores upload state in IndexedDB. On next extension load:

```
chrome.runtime.onStartup / onInstalled
  → triggerOffscreenQueueProcessing()
  → OFFSCREEN_PROCESS_QUEUE
  → Resumes incomplete uploads from the last successful chunk
```

---

## Authentication

### Token Flow

```
Email/Password Login:
  POST /api/auth/login
  → bcrypt.compare(password, hash)  [12 rounds]
  → Generate JWT access token  (30m, HS256)
  → Generate refresh token     (10d)
  → Store Session row in DB
  → Extension stores in chrome.storage.local

Google OAuth:
  Extension opens tab → /api/auth/google
  → Google consent page
  → /api/auth/google/callback
  → Redirect: localhost:3001/auth/callback?accessToken=...&refreshToken=...
  → chrome.tabs.onUpdated intercepts the callback URL
  → Closes OAuth tab immediately
  → Fetches /api/auth/me with accessToken
  → Stores tokens + user in chrome.storage.local
  → Broadcasts OAUTH_LOGIN_COMPLETE to popup

Token Refresh:
  chrome.alarms fires before access token expiry
  → authManager.refreshTokens()
  → POST /api/auth/refresh { refreshToken }
  → New access token → chrome.storage.local
```

### JWT Configuration

| Setting           | Value      |
| ----------------- | ---------- |
| Access token TTL  | 30 minutes |
| Refresh token TTL | 10 days    |
| Algorithm         | HS256      |
| Bcrypt rounds     | 12         |

---

## Infrastructure & Docker

### Services

| Service         | Image                | Port             | Description         |
| --------------- | -------------------- | ---------------- | ------------------- |
| `jam_postgres`  | postgres:15-alpine   | 5432             | Primary database    |
| `jam_redis`     | redis:7-alpine       | 6379             | Queue + cache       |
| `jam_backend`   | backend.Dockerfile   | 4000 (local dev) | Express API         |
| `jam_worker`    | worker.Dockerfile    | 3002 (health)    | Video processing    |
| `jam_dashboard` | dashboard.Dockerfile | 3001             | React SPA (Nginx)   |
| `jam_nginx`     | nginx:1.25-alpine    | 80, 443          | Reverse proxy + SSL |

**Redis flags:**

```
--requirepass ${REDIS_PASSWORD}
--appendonly yes            (AOF — survives restarts)
--maxmemory 256mb
--maxmemory-policy allkeys-lru
```

**Docker volumes:**

- `postgres_data` — Database files
- `redis_data` — AOF journal
- `uploads_tmp` — Temp chunk working directory
- `nginx_logs` — Access and error logs

---

## Environment Variables

### `apps/backend/.env`

```env
PORT=4000
NODE_ENV=development
DATABASE_URL="postgresql://jam:jampassword@localhost:5432/jamdb"
REDIS_URL="redis://:redis-password@localhost:6379"
REDIS_PASSWORD="redis-password"
JWT_SECRET="Lfh2gxxTi7KioxVBVxg7NzoKluc16_q82LrMpI3m-hmQf6M5f2AjOG4EfbCuUOuU"
JWT_REFRESH_SECRET="hwDM8GdXBCGyYFyeRtT7ZOsW-HYIBlhJh6I5PPvnTC4DjQOpm84DkIUUfMghKNr6"
JWT_EXPIRES_IN="30m"
JWT_REFRESH_EXPIRES_IN="10d"
EXTERNAL_API_BASE_URL="http://localhost:3000"
EXTERNAL_API_TOKEN=""
EXTERNAL_API_USERNAME="superadmin"
EXTERNAL_API_PASSWORD="your-portal-password"
EXTERNAL_PROJECT_ID=""
EXTERNAL_TASK_LABEL="Screen Recording"
EXTERNAL_TASK_PRIORITY="P0"
CLOUDINARY_CLOUD_NAME=""
CLOUDINARY_API_KEY=""
CLOUDINARY_API_SECRET=""
CORS_ORIGIN="http://localhost:3000,http://localhost:3001,chrome-extension://ndaeclgbabnjjcmffjdibmbkndiakkne"
RATE_LIMIT_WINDOW=900000
RATE_LIMIT_MAX=100
BCRYPT_ROUNDS=12
UPLOAD_MAX_SIZE=5368709120
CHUNK_SIZE=5242880
FRONTEND_URL="http://localhost:3001"
GOOGLE_CLIENT_ID="your-google-client-id.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="your-google-client-secret"
GOOGLE_CALLBACK_URL="http://localhost:4000/api/auth/google/callback"
SMTP_HOST="smtp.gmail.com"
SMTP_PORT=587
SMTP_USER="your-email@gmail.com"
SMTP_PASS="your-gmail-app-password"
EMAIL_FROM="noreply@snaptrace.app"
```

### `apps/extension/.env`

```env
VITE_API_BASE_URL=http://localhost:4000/api
VITE_APP_NAME=SnapTrace
VITE_APP_VERSION=1.0.0
```

### `apps/dashboard/.env` (optional)

```env
VITE_API_BASE_URL=http://localhost:4000/api
```

### `apps/worker/.env` (optional — only if running worker separately)

```env
REDIS_URL=redis://:redis-password@localhost:6379
DATABASE_URL=postgresql://jam:jampassword@localhost:5432/jamdb
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
WORKER_CONCURRENCY=3
WORKER_HEALTH_PORT=3002
TEMP_DIR=/tmp/jam-worker
NODE_ENV=development
```

---

## API Reference

### Authentication header

```
Authorization: Bearer <accessToken>
```

### Response envelope

```json
{ "success": true, "data": { ... } }
{ "success": false, "error": "ERROR_CODE", "message": "Human readable message" }
```

### Error codes

| Code                     | HTTP | Meaning                                     |
| ------------------------ | ---- | ------------------------------------------- |
| `NOT_FOUND`              | 404  | Resource does not exist                     |
| `FORBIDDEN`              | 403  | Authenticated but not the owner             |
| `UNAUTHORIZED`           | 401  | Missing or expired token                    |
| `INVALID_STATE`          | 400  | Recording in wrong status for the operation |
| `INCOMPLETE_UPLOAD`      | 400  | Not all chunks uploaded yet                 |
| `SESSION_EXPIRED`        | 400  | Redis upload session expired                |
| `EXTERNAL_UPLOAD_FAILED` | 502  | ReportPortal file upload failed             |
| `EXTERNAL_RECORD_FAILED` | 502  | ReportPortal record creation failed         |
| `INTERNAL_ERROR`         | 500  | Unexpected server error                     |

---

## Keyboard Shortcuts

| Windows / Linux | Mac           | Action          |
| --------------- | ------------- | --------------- |
| `Ctrl+Shift+R`  | `Cmd+Shift+R` | Start recording |
| `Ctrl+Shift+S`  | `Cmd+Shift+S` | Stop recording  |
| `Ctrl+Shift+X`  | `Cmd+Shift+X` | Take screenshot |

---

## Known Limitations

- **ReportPortal required.** Videos are stored in a ReportPortal instance at `EXTERNAL_API_BASE_URL`. Without it, upload finalize returns `502`. There is no fallback storage.
- **FFmpeg required for MP4 output.** Without FFmpeg, the worker concatenates raw `.webm` chunks without transcoding. The video is playable but unoptimized.
- **Chrome only.** The extension uses `chrome.debugger`, `tabCapture`, and `offscreen` — Chrome-exclusive APIs. Firefox and Safari are not supported.
- **Cloudinary code exists but is unused in the upload flow.** `storage.ts` in the backend and the worker both have Cloudinary implementations that are wired up but the primary upload path goes through External API.
- **BigInt serialization.** Prisma returns `size` as `BigInt`. The backend applies a global JSON replacer to convert BigInt to string. If you consume the API directly, `size` arrives as a numeric string.
- **Webcam overlay is client-side only.** Webcam picture-in-picture is rendered in the browser; it is not composited into the final video file.

---

## Complete Setup Guide — New Laptop / New Device

### Prerequisites — Install These First

| Tool               | Version | Install                                        |
| ------------------ | ------- | ---------------------------------------------- |
| **Node.js**        | >= 18   | [nodejs.org](https://nodejs.org)               |
| **pnpm**           | 8.15.0  | `npm install -g pnpm@8.15.0`                   |
| **Docker Desktop** | latest  | [docker.com](https://www.docker.com)           |
| **Git**            | any     | pre-installed on Mac / `brew install git`      |
| **Google Chrome**  | latest  | [chrome.google.com](https://chrome.google.com) |

---

### Step 1 — Clone the Repo

```bash
git clone <your-repo-url>
cd Jam_Recorder-extension
```

---

### Step 2 — Create Environment Files

**`apps/backend/.env`** — create this file with exactly this content:

```env
PORT=4000
NODE_ENV=development
DATABASE_URL="postgresql://jam:jampassword@localhost:5432/jamdb"
REDIS_URL="redis://:redis-password@localhost:6379"
REDIS_PASSWORD="redis-password"
JWT_SECRET="Lfh2gxxTi7KioxVBVxg7NzoKluc16_q82LrMpI3m-hmQf6M5f2AjOG4EfbCuUOuU"
JWT_REFRESH_SECRET="hwDM8GdXBCGyYFyeRtT7ZOsW-HYIBlhJh6I5PPvnTC4DjQOpm84DkIUUfMghKNr6"
JWT_EXPIRES_IN="30m"
JWT_REFRESH_EXPIRES_IN="10d"
EXTERNAL_API_BASE_URL="http://localhost:3000"
EXTERNAL_API_TOKEN=""
EXTERNAL_API_USERNAME="superadmin"
EXTERNAL_API_PASSWORD="your-portal-password"
EXTERNAL_PROJECT_ID=""
EXTERNAL_TASK_LABEL="Screen Recording"
EXTERNAL_TASK_PRIORITY="P0"
CLOUDINARY_CLOUD_NAME=""
CLOUDINARY_API_KEY=""
CLOUDINARY_API_SECRET=""
CORS_ORIGIN="http://localhost:3000,http://localhost:3001,chrome-extension://ndaeclgbabnjjcmffjdibmbkndiakkne"
RATE_LIMIT_WINDOW=900000
RATE_LIMIT_MAX=100
BCRYPT_ROUNDS=12
UPLOAD_MAX_SIZE=5368709120
CHUNK_SIZE=5242880
FRONTEND_URL="http://localhost:3001"
GOOGLE_CLIENT_ID="your-google-client-id.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="your-google-client-secret"
GOOGLE_CALLBACK_URL="http://localhost:4000/api/auth/google/callback"
SMTP_HOST="smtp.gmail.com"
SMTP_PORT=587
SMTP_USER="your-email@gmail.com"
SMTP_PASS="your-gmail-app-password"
EMAIL_FROM="noreply@snaptrace.app"
```

**`apps/extension/.env`** — create this file:

```env
VITE_API_BASE_URL=http://localhost:4000/api
VITE_APP_NAME=SnapTrace
VITE_APP_VERSION=1.0.0
```

---

### Step 3 — Install Dependencies

```bash
pnpm install
```

---

### Step 4 — Start Docker (PostgreSQL + Redis)

```bash
docker-compose up -d postgres redis
```

Wait ~10 seconds for containers to be healthy, then verify:

```bash
docker ps
```

You should see `jam_postgres` and `jam_redis` both with status `Up`.

---

### Step 5 — Run Database Migrations

```bash
cd apps/backend
pnpm exec prisma migrate deploy
cd ../..
```

Expected output: `2 migrations found... No pending migrations to apply.`

---

### Step 6 — Generate Prisma Client

```bash
cd apps/backend
pnpm exec prisma generate
cd ../..
```

---

### Step 7 — Start the Backend

Open a **new terminal** and keep it running:

```bash
cd apps/backend
pnpm dev
```

Wait until you see:

```
[Redis] Connected
[Database] Connected to PostgreSQL via Prisma
Server started {"port":4000,"env":"development"}
```

---

### Step 8 — Build the Extension

Open another **new terminal**:

```bash
cd apps/extension
pnpm dev
```

Wait until you see: `✓ All steps completed.`

---

### Step 9 — Load Extension in Chrome

1. Open Chrome → go to `chrome://extensions`
2. Toggle **Developer mode** ON (top right)
3. Click **Load unpacked**
4. Select this folder:
   ```
   <project-root>/apps/extension/dist
   ```
5. The **SnapTrace Recorder** icon appears in your toolbar

---

### Step 10 — Verify Everything Works

```bash
# Should return {"success":false,"error":"INVALID_CREDENTIALS"...} — means backend is up
curl -s -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"test"}'
```

Now open the extension → login with your credentials → it should work.

---

### What Runs Where

| Service              | Command                                                  | Port |
| -------------------- | -------------------------------------------------------- | ---- |
| PostgreSQL           | `docker-compose up -d postgres redis`                    | 5432 |
| Redis                | same as above                                            | 6379 |
| Backend API          | `cd apps/backend && pnpm dev`                            | 4000 |
| Extension            | `cd apps/extension && pnpm dev` → load `dist/` in Chrome | —    |
| Dashboard (optional) | `cd apps/dashboard && pnpm dev`                          | 3001 |

> **Important:** Videos are stored in a **ReportPortal** instance at `EXTERNAL_API_BASE_URL` (`http://localhost:3000` by default). That service must also be running for recordings to upload and play back successfully.

---

## License

MIT © SnapTrace Contributors
