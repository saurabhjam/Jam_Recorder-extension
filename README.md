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
4. [Chrome Extension — Deep Dive](#chrome-extension--deep-dive)
5. [Backend API](#backend-api)
6. [Video Worker](#video-worker)
7. [Dashboard](#dashboard)
8. [Database Schema](#database-schema)
9. [Queue System](#queue-system)
10. [Data Capture Pipeline](#data-capture-pipeline)
11. [Recording Lifecycle](#recording-lifecycle)
12. [Upload Pipeline](#upload-pipeline)
13. [Authentication](#authentication)
14. [Storage — Cloudinary](#storage--cloudinary)
15. [Infrastructure & Docker](#infrastructure--docker)
16. [Environment Variables](#environment-variables)
17. [Local Development](#local-development)
18. [Keyboard Shortcuts](#keyboard-shortcuts)
19. [API Reference](#api-reference)
20. [Tech Stack](#tech-stack)
21. [Known Limitations](#known-limitations)

---

## What is SnapTrace?

SnapTrace is a **self-hosted, open-source screen recording and bug reporting platform** built for engineering and product teams. It captures full-screen or tab recordings with synchronized console logs, network requests, and user actions — then shares them instantly via a public link.

**Key differentiators:**

- **Zero-install sharing** — Recipients need no extension; recordings stream from a public URL.
- **Deep browser instrumentation** — Records console logs and network requests using Chrome DevTools Protocol (CDP), not just screen pixels.
- **Offline-first upload** — Chunks are stored in IndexedDB; incomplete uploads resume automatically when connectivity returns.
- **Service worker resilient** — All recording state survives Chrome's MV3 service worker suspension via `chrome.storage.session` and `chrome.storage.local`.
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
│         ┌──────────────────────────────────────────────────┐   │
│         │          Background Service Worker               │   │
│         │  (CDP, state, auth, toolbar injection, routing)  │   │
│         └──────────────────────┬───────────────────────────┘   │
└──────────────────────────────────────────────────────────────  ┘
                                 │ HTTPS
                  ┌──────────────▼──────────────┐
                  │         Backend API          │
                  │    Express + Prisma ORM      │
                  │       localhost:3000         │
                  └──────┬────────────┬──────────┘
                         │            │
            ┌────────────▼──┐   ┌────▼──────────────┐
            │  PostgreSQL   │   │  Redis + BullMQ   │
            │  (port 5432)  │   │  (port 6379)      │
            └───────────────┘   └────────┬──────────┘
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
```

---

## Monorepo Structure

```
Jam_Recorder-extension/
├── apps/
│   ├── extension/          Chrome Extension (MV3, React + TypeScript)
│   ├── backend/            Express API (Node.js, Prisma, BullMQ)
│   ├── worker/             Video processing worker (FFmpeg, BullMQ)
│   └── dashboard/          Web dashboard (React + Vite)
├── packages/
│   ├── types/              Shared TypeScript types
│   ├── config/             Shared constants (queue names, TTLs, Cloudinary folders)
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

## Chrome Extension — Deep Dive

### Manifest V3

The extension targets **Manifest V3** — Chrome's current extension platform that replaces the persistent background page with a short-lived service worker.

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
Popup UI             ─────────────────────────────────────┐
Content Script (tab) ─────────────────────────────────────┤
Editor Window        ─────────────────────────────────────┼──► Background Service Worker
Offscreen Document   ─────────────────────────────────────┘          (orchestrator)
```

---

### 1. Background Service Worker (`src/background/index.ts`)

The central orchestrator — ~1,300 lines. Manages everything that requires cross-context coordination.

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

`void restoreStateFromStorage()` is called at module bottom (runs on every SW activation):

1. Reads both storages in parallel
2. Restores all in-memory variables (`currentRecordingId`, `isRecordingActive`, etc.)
3. Restarts the elapsed-time timer
4. Re-attaches the CDP debugger to the recording tab
5. Restores accumulated `cdpConsoleLogs` + `cdpNetworkEntries` from session storage

CDP captures are flushed to session storage at most every **2 seconds** (debounced via `scheduleCaptureFlush`) — so at most 2 seconds of events are lost if Chrome kills the SW mid-recording.

---

### 2. Content Script (`src/content/index.ts`)

Injected at `document_start` into **every** browser tab.

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
- Some extension contexts behave differently under CDP

The content script fills those gaps. On stop, both datasets are merged with **500ms bucket deduplication** — CDP entries always win; a content-script entry is only added if no CDP entry matches the same `url|method|level` combination within the same 500ms window.

---

### 3. Main-World Capture (`captureScriptMain`)

Injected by the background via `chrome.scripting.executeScript({ world: 'MAIN' })` into the **page's main JavaScript execution context**. Running in MAIN world means the code bypasses any Content Security Policy restrictions on the page.

**Patches three browser APIs:**

| API                  | How                                                      | Data captured                                   |
| -------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| `XMLHttpRequest`     | Wraps `open()` + `send()`; listens to `loadend`          | URL, method, status, statusText, duration, size |
| `window.fetch`       | Wraps with `.then()` + `.clone().arrayBuffer()` for size | URL, method, status, duration, byteLength       |
| `console.*`          | Wraps `log`, `info`, `warn`, `error`, `debug`            | level, joined args, timestamp, `location.href`  |
| `window.onerror`     | Adds listener                                            | error message, timestamp                        |
| `unhandledrejection` | Adds listener                                            | rejection reason message                        |

All data is posted via `window.postMessage({ __st: true, ...data }, '*')` and received by the content script's message listener.

**Guard:** Checks `window.__stCapture` — running it twice on the same page is a no-op.

---

### 4. Offscreen Document (`src/offscreen/`)

A hidden HTML page created by the service worker using `chrome.offscreen.createDocument`. Offscreen documents have access to APIs unavailable in service workers: `getUserMedia`, `MediaRecorder`, `AudioContext`, `createObjectURL`, `IndexedDB`.

**Responsibilities:**

| Task               | Detail                                                                   |
| ------------------ | ------------------------------------------------------------------------ |
| Stream acquisition | `tabCapture.getMediaStreamId` + `getUserMedia` for webcam/mic            |
| Audio mixing       | `AudioContext` combines system audio + microphone + webcam audio         |
| Video recording    | `MediaRecorder` collects Blobs every ~1s                                 |
| Thumbnail          | First frame drawn to `<canvas>` → `toDataURL('image/jpeg', 0.85)`        |
| Blob persistence   | Written to IndexedDB (`snaptrace-recordings` DB, keyed by `recordingId`) |
| Chunked upload     | Splits blob into 5MB chunks; uploads with SHA-256 checksum               |
| Offline queue      | Stores incomplete uploads in IndexedDB; resumes on next extension load   |

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

### 5. Popup UI (`src/popup/`)

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

### 6. Editor Window (`src/editor/`)

Standalone popup window (960×680px) opened automatically after recording stops.

- Preview the recorded video
- Review captured console logs and network requests
- Edit recording title and description
- Annotate with drawing tools
- Trigger chunked upload to backend

---

### CDP Events Captured

**Network domain:**

| Event                       | Fields recorded                                |
| --------------------------- | ---------------------------------------------- |
| `Network.requestWillBeSent` | `url`, `method`, `initiator.type`, `timestamp` |
| `Network.responseReceived`  | `status`, `statusText`, `mimeType`             |
| `Network.loadingFinished`   | `encodedDataLength` (size), total duration     |
| `Network.loadingFailed`     | `errorText`, duration                          |

**Runtime domain:**

| Event                      | Fields recorded                                      |
| -------------------------- | ---------------------------------------------------- |
| `Runtime.consoleAPICalled` | `type` (level), args joined to string                |
| `Runtime.exceptionThrown`  | `exceptionDetails.exception.description`, source URL |

**Log domain:**

| Event            | Fields recorded        |
| ---------------- | ---------------------- |
| `Log.entryAdded` | `level`, `text`, `url` |

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
**Base URL:** `http://localhost:3000/api`

### Auth — `/api/auth`

| Method | Path               | Description                           |
| ------ | ------------------ | ------------------------------------- |
| `POST` | `/register`        | Create account (rate-limited)         |
| `POST` | `/login`           | Email + password login                |
| `POST` | `/refresh`         | Refresh access token                  |
| `POST` | `/logout`          | Revoke current or all sessions        |
| `GET`  | `/me`              | Get current user profile              |
| `PUT`  | `/me`              | Update profile name / avatar          |
| `POST` | `/forgot-password` | Send password reset email             |
| `POST` | `/reset-password`  | Confirm reset with token              |
| `GET`  | `/google`          | Redirect to Google OAuth consent      |
| `GET`  | `/google/callback` | OAuth callback → redirect with tokens |

### Recordings — `/api/recordings`

| Method   | Path               | Auth     | Description                                 |
| -------- | ------------------ | -------- | ------------------------------------------- |
| `GET`    | `/`                | Required | List recordings (paginated, search, filter) |
| `POST`   | `/`                | Required | Create recording record                     |
| `GET`    | `/share/:shareId`  | Optional | Get public recording by shareId             |
| `GET`    | `/public/:shareId` | Optional | Legacy public endpoint                      |
| `GET`    | `/:id`             | Required | Get single recording                        |
| `PUT`    | `/:id`             | Required | Update title, description, visibility       |
| `DELETE` | `/:id`             | Required | Delete recording                            |
| `POST`   | `/:id/view`        | Optional | Increment view counter                      |
| `GET`    | `/:id/analytics`   | Required | Views, visitors, event breakdown            |
| `POST`   | `/:id/reprocess`   | Required | Re-queue a stuck recording                  |

**Query params for `GET /`:**

| Param       | Type   | Default     |
| ----------- | ------ | ----------- |
| `page`      | number | 1           |
| `limit`     | number | 20          |
| `status`    | string | —           |
| `type`      | string | —           |
| `search`    | string | —           |
| `sortBy`    | string | `createdAt` |
| `sortOrder` | string | `desc`      |

### Uploads — `/api/uploads`

| Method   | Path                     | Description                                |
| -------- | ------------------------ | ------------------------------------------ |
| `POST`   | `/initiate`              | Begin chunked upload session               |
| `POST`   | `/chunk`                 | Upload one 5MB chunk with SHA-256 checksum |
| `GET`    | `/progress/:recordingId` | Poll upload progress                       |
| `POST`   | `/complete/:recordingId` | Verify all chunks, enqueue worker          |
| `DELETE` | `/abort/:recordingId`    | Cancel and clean up chunks                 |

### Comments — `/api/recordings/:id/comments`

| Method   | Path          | Description                                    |
| -------- | ------------- | ---------------------------------------------- |
| `GET`    | `/`           | List comments (threaded)                       |
| `POST`   | `/`           | Create comment with optional video `timestamp` |
| `PUT`    | `/:commentId` | Edit comment                                   |
| `DELETE` | `/:commentId` | Delete comment                                 |

### Shares — `/api/shares`

| Method   | Path      | Description                                    |
| -------- | --------- | ---------------------------------------------- |
| `POST`   | `/`       | Create share link (optional password + expiry) |
| `GET`    | `/`       | List share links                               |
| `GET`    | `/:token` | Resolve share link                             |
| `DELETE` | `/:id`    | Revoke share link                              |

### Teams — `/api/teams`

| Method   | Path                 | Description             |
| -------- | -------------------- | ----------------------- |
| `POST`   | `/`                  | Create team             |
| `GET`    | `/`                  | List teams              |
| `GET`    | `/:id`               | Get team details        |
| `PUT`    | `/:id`               | Update team             |
| `POST`   | `/:id/invite`        | Send invite by email    |
| `POST`   | `/:id/accept-invite` | Accept invite via token |
| `DELETE` | `/:id/member`        | Remove member           |

---

## Video Worker

**Queue library:** BullMQ  
**Video processing:** FFmpeg via `fluent-ffmpeg`  
**Cloud storage:** Cloudinary  
**Concurrency:** 3 jobs in parallel (configurable via `WORKER_CONCURRENCY`)

### Processing Steps

```
BullMQ dequeues VideoProcessingJob
  │
  ├── 1.  Create temp dir: /tmp/jam-worker/rec_<id>_<ts>/
  ├── 2.  Set recording status → PROCESSING                      [5%]
  ├── 3.  Fetch all UploadChunk URLs from DB (ordered by index)
  ├── 4.  Download all chunks from Cloudinary                    [5–35%]
  │
  ├── 5.  Check FFmpeg
  │         ├── [Available]
  │         │     ├── Merge .webm chunks → merged.webm           [35–50%]
  │         │     ├── Get video metadata (duration, resolution, fps)
  │         │     ├── Transcode to .mp4 (H.264, AAC, ≤1080p)    [50–80%]
  │         │     └── Get final metadata
  │         │
  │         └── [Not available — fallback]
  │               └── Buffer.concat(chunks) → recording.webm    [60%]
  │
  ├── 6.  Upload final video to Cloudinary                       [80–95%]
  │         folder: jam-recordings/<userId>/
  │         publicId: rec_<recordingId>
  │
  ├── 7.  Update recording → READY                               [95%]
  │         url, duration (Math.round → Int), size (BigInt), mimeType
  │
  ├── 8.  Enqueue ThumbnailJob
  ├── 9.  Enqueue NotificationJob ("Recording ready")
  └── 10. Cleanup temp dir                                       [100%]
```

**Retry policy:** 3 attempts, exponential backoff (2s, 4s, 8s). On final failure: status → `FAILED`, job retained for 7 days.

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

### Share Page — Polling Logic

The share page (`/share/:shareId`) must handle recordings that are still processing:

1. Polls backend every **2 seconds** while `status === 'PROCESSING' | 'UPLOADING'`
2. On 404 (recording not yet visible), retries up to **15 times** at **3-second** intervals
3. Shows a loading spinner during polling via `isFetching` — not just `isLoading`
4. Shows "Recording not found" only after all 15 retries are exhausted
5. Renders `<VideoPlayer>` immediately once `recording.url` is present

---

## Database Schema

**Database:** PostgreSQL 15  
**ORM:** Prisma 5

### Core Models

#### `User`

```
id                   String    @id @default(cuid())
email                String    @unique
name                 String
password             String?   (null for Google OAuth users)
avatar               String?
isVerified           Boolean   @default(false)
isActive             Boolean   @default(true)
teamId               String?   → Team
googleId             String?   @unique
passwordResetToken   String?
passwordResetExpires DateTime?
createdAt / updatedAt
```

#### `Recording`

```
id           String          @id @default(cuid())
title        String
description  String?
userId       String          → User
teamId       String?         → Team
status       RecordingStatus @default(UPLOADING)
type         RecordingType   @default(SCREEN)
url          String?         (set when READY — Cloudinary URL)
thumbnailUrl String?
duration     Int?            (seconds, INTEGER — not float)
size         BigInt?         (bytes, BIGINT)
mimeType     String          @default("video/webm")
shareId      String          @unique @default(cuid())
isPublic     Boolean         @default(true)
allowDownload Boolean        @default(true)
viewCount    Int             @default(0)
metadata     Json?           (browser, OS, viewport, consoleLogs, networkLogs)
consoleLogs  Json?
networkLogs  Json?
```

#### `UploadChunk`

```
id          String   @id
recordingId String   → Recording (cascade delete)
chunkIndex  Int
totalChunks Int
size        Int
checksum    String   (SHA-256)
cloudUrl    String?
uploadedAt  DateTime @default(now())
@@unique([recordingId, chunkIndex])
```

#### Other Models

| Model           | Purpose                                           |
| --------------- | ------------------------------------------------- |
| `Session`       | Refresh token store — one row per device          |
| `Team`          | Workspace with name, slug, plan                   |
| `TeamInvite`    | Pending invitations by email + token              |
| `ShareLink`     | Token-based share with optional password + expiry |
| `Comment`       | Timestamped video comments with threading         |
| `Analytics`     | Per-event view tracking (visitorId, IP, referer)  |
| `Notification`  | In-app notifications                              |
| `ActivityLog`   | Audit trail for user actions                      |
| `PasswordReset` | One-time password reset tokens                    |

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

**Library:** BullMQ 4  
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
VideoProcessingJob { recordingId, userId, mimeType, totalChunks }
ThumbnailJob       { recordingId, videoUrl }
NotificationJob    { userId, type, title, message, metadata? }
AnalyticsJob       { event, recordingId, userId?, visitorId?, ip?, userAgent?, referer? }
```

### BullMQ Connection

Both backend and worker parse Redis credentials from `REDIS_URL`:

```typescript
// Extracts host, port, password from the URL — single source of truth
const url = new URL(config.redis.url);
return { host: url.hostname, port: parseInt(url.port || '6379'), password: url.password };
```

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
  ├── CDP events → background
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
                        → shown in editor + uploaded in recording.metadata
```

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
  │ Chunked upload to backend (5MB chunks, SHA-256 verified)
  │ → OFFSCREEN_UPLOAD_COMPLETE
  ▼
done
  Share URL on clipboard, popup shows share view
```

---

## Upload Pipeline

### Chunked Upload Detail

```
Offscreen reads blob from IndexedDB
  │
  ├── POST /api/uploads/initiate
  │     { recordingId, totalChunks } → { uploadId }
  │
  ├── For each 5MB chunk (sequential or parallel):
  │     POST /api/uploads/chunk
  │     multipart: { recordingId, chunkIndex, totalChunks, chunk, checksum }
  │     → Backend: verify SHA-256
  │     → Upload chunk to Cloudinary (folder: jam-chunks/)
  │     → Upsert UploadChunk row in DB
  │     → Update Redis progress cache
  │
  └── POST /api/uploads/complete/:recordingId
        → Verify all chunks present + no index gaps
        → Recording status → PROCESSING
        → Enqueue VideoProcessingJob (deduped by jobId)
        → Return { shareId }
```

### Offline Queue

If upload is interrupted (network drop, extension reload), chunks already on Cloudinary are preserved. The offscreen document stores upload state in IndexedDB (`snaptrace-offline-queue`). On next extension load:

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

| Setting           | Value         |
| ----------------- | ------------- |
| Access token TTL  | 30 minutes    |
| Refresh token TTL | 10 days       |
| Algorithm         | HS256         |
| Secret minimum    | 32 characters |
| Bcrypt rounds     | 12            |

---

## Storage — Cloudinary

All media is stored in **Cloudinary**. Two namespaces:

| Folder                     | Contents                                                |
| -------------------------- | ------------------------------------------------------- |
| `jam-chunks/`              | Raw upload chunks — temporary, cleaned after processing |
| `jam-recordings/<userId>/` | Final processed videos — permanent                      |

**Upload options:**

- `resource_type: 'raw'` for chunks (preserves binary)
- `resource_type: 'video'` for final recordings
- `tags: ['recording', 'user_<userId>']`
- Custom metadata: `{ recordingId, userId }`

---

## Infrastructure & Docker

### Services

| Service         | Image                | Port          | Description         |
| --------------- | -------------------- | ------------- | ------------------- |
| `jam_postgres`  | postgres:15-alpine   | 5432          | Primary database    |
| `jam_redis`     | redis:7-alpine       | 6379          | Queue + cache       |
| `jam_backend`   | backend.Dockerfile   | 3000          | Express API         |
| `jam_worker`    | worker.Dockerfile    | 3002 (health) | Video processing    |
| `jam_dashboard` | dashboard.Dockerfile | 3001          | React SPA (Nginx)   |
| `jam_nginx`     | nginx:alpine         | 80, 443       | Reverse proxy + SSL |

**Redis flags:**

```
--requirepass ${REDIS_PASSWORD}
--appendonly yes            (AOF — survives restarts)
--maxmemory 256mb
--maxmemory-policy allkeys-lru
```

**Volumes:**

- `postgres_data` — Database files
- `redis_data` — AOF journal
- `uploads_tmp` — Temp FFmpeg working directory
- `nginx_logs` — Access and error logs

---

## Environment Variables

### `apps/backend/.env`

```bash
PORT=3000
NODE_ENV=development
DATABASE_URL="postgresql://jam:jampassword@localhost:5432/jamdb"
REDIS_URL="redis://:redis-password@localhost:6379"
REDIS_PASSWORD="redis-password"
JWT_SECRET="..."                    # min 32 chars
JWT_REFRESH_SECRET="..."            # min 32 chars
JWT_EXPIRES_IN="30m"
JWT_REFRESH_EXPIRES_IN="10d"
CLOUDINARY_CLOUD_NAME="..."
CLOUDINARY_API_KEY="..."
CLOUDINARY_API_SECRET="..."
CORS_ORIGIN="http://localhost:3000,http://localhost:3001,chrome-extension://<id>"
FRONTEND_URL="http://localhost:3001"
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
GOOGLE_CALLBACK_URL="http://localhost:3000/api/auth/google/callback"
SMTP_HOST="smtp.gmail.com"
SMTP_PORT=587
SMTP_USER="..."
SMTP_PASS="..."                     # Gmail App Password
EMAIL_FROM="noreply@snaptrace.app"
BCRYPT_ROUNDS=12
UPLOAD_MAX_SIZE=5368709120          # 5 GB
CHUNK_SIZE=5242880                  # 5 MB
```

### `apps/worker/.env`

```bash
REDIS_URL=redis://:redis-password@localhost:6379
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=redis-password
DATABASE_URL=postgresql://jam:jampassword@localhost:5432/jamdb
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
VIDEO_QUEUE_NAME=video-processing
THUMBNAIL_QUEUE_NAME=thumbnail-generation
NOTIFICATION_QUEUE_NAME=notifications
WORKER_CONCURRENCY=3
WORKER_HEALTH_PORT=3002
TEMP_DIR=/tmp/jam-worker
FFMPEG_PATH=/usr/bin/ffmpeg
FFPROBE_PATH=/usr/bin/ffprobe
BACKEND_URL=http://localhost:3000
NODE_ENV=development
LOG_LEVEL=info
```

### `apps/extension/.env`

```bash
VITE_API_BASE_URL=http://localhost:3000/api
VITE_APP_NAME=SnapTrace
VITE_APP_VERSION=1.0.0
```

### `apps/dashboard/.env`

```bash
VITE_API_BASE_URL=http://localhost:3000/api
VITE_BACKEND_URL=http://localhost:3000
```

---

## Local Development

### Prerequisites

- Node.js 18+
- pnpm 8.15+
- Docker + Docker Compose
- Chrome browser

### 1. Start infrastructure

```bash
docker compose up jam_postgres jam_redis -d
docker ps    # verify both show (healthy)
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Set up database

```bash
cd apps/backend
pnpm prisma migrate dev
pnpm prisma generate
```

### 4. Start all services

```bash
# From repo root — Turborepo runs all dev tasks in parallel
pnpm dev
```

Or individually in separate terminals:

```bash
# Backend API (port 3000)
cd apps/backend && pnpm dev

# Worker
cd apps/worker && pnpm dev

# Dashboard (port 3001)
cd apps/dashboard && pnpm dev

# Extension watch build
cd apps/extension && pnpm dev
```

### 5. Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select `apps/extension/dist/`

### 6. Database GUI

```bash
# Prisma Studio — opens at http://localhost:5555
cd apps/backend && npx prisma studio
```

### Common Commands

```bash
pnpm build         # Build all packages
pnpm lint          # ESLint across all packages
pnpm type-check    # TypeScript check all packages
pnpm format        # Prettier format everything
pnpm test          # Run all tests
```

---

## Keyboard Shortcuts

| Windows / Linux | Mac           | Action          |
| --------------- | ------------- | --------------- |
| `Ctrl+Shift+R`  | `Cmd+Shift+R` | Start recording |
| `Ctrl+Shift+S`  | `Cmd+Shift+S` | Stop recording  |
| `Ctrl+Shift+X`  | `Cmd+Shift+X` | Take screenshot |

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

| Code                | HTTP | Meaning                                          |
| ------------------- | ---- | ------------------------------------------------ |
| `NOT_FOUND`         | 404  | Resource does not exist                          |
| `FORBIDDEN`         | 403  | Authenticated but not the owner                  |
| `UNAUTHORIZED`      | 401  | Missing or expired token                         |
| `INVALID_STATE`     | 400  | Recording in wrong status for the operation      |
| `CHECKSUM_MISMATCH` | 400  | Chunk SHA-256 didn't match the provided checksum |
| `INCOMPLETE_UPLOAD` | 400  | Not all chunks uploaded yet                      |
| `MISSING_CHUNK`     | 400  | Gap detected in chunk index sequence             |
| `INTERNAL_ERROR`    | 500  | Unexpected server error                          |

---

## Tech Stack

### Extension

| Technology               | Purpose                                       |
| ------------------------ | --------------------------------------------- |
| TypeScript 5.4           | Type safety across all extension contexts     |
| React 18                 | Popup, floating toolbar, and editor UIs       |
| Vite + CRXJS             | Extension build with HMR                      |
| Chrome MV3 APIs          | Tabs, storage, scripting, debugger, offscreen |
| Chrome DevTools Protocol | Deep browser instrumentation                  |

### Backend

| Technology             | Purpose                              |
| ---------------------- | ------------------------------------ |
| Node.js 18 + Express 4 | HTTP server                          |
| Prisma 5               | ORM + migration runner               |
| PostgreSQL 15          | Primary database                     |
| Redis 7                | Cache + BullMQ queue backend         |
| BullMQ 4               | Job queue with persistence and retry |
| Passport.js            | Google OAuth 2.0 strategy            |
| jsonwebtoken           | JWT generation and verification      |
| bcrypt                 | Password hashing (12 rounds)         |
| Cloudinary SDK         | Video and chunk cloud storage        |
| Zod                    | Request validation + env schema      |
| Helmet                 | Security headers                     |

### Worker

| Technology    | Purpose                             |
| ------------- | ----------------------------------- |
| Node.js 18    | Runtime                             |
| FFmpeg        | Video transcoding and chunk merging |
| fluent-ffmpeg | FFmpeg Node.js wrapper              |
| BullMQ 4      | Job consumer                        |
| Axios         | Chunk download from Cloudinary      |
| Prisma 5      | Database status updates             |

### Dashboard

| Technology      | Purpose                   |
| --------------- | ------------------------- |
| React 18 + Vite | UI framework + build tool |
| React Router 6  | Client-side routing       |
| React Query 5   | Server state + polling    |
| Zustand         | Auth store                |
| Tailwind CSS 3  | Utility-first styling     |
| Framer Motion   | Animations                |
| Lucide React    | Icons                     |

### Tooling

| Tool                   | Purpose                                  |
| ---------------------- | ---------------------------------------- |
| Turborepo              | Monorepo task orchestration with caching |
| pnpm 8.15              | Workspaces + fast installs               |
| Husky + commitlint     | Conventional commit enforcement          |
| lint-staged + Prettier | Auto-format on commit                    |
| ESLint                 | Static analysis across all packages      |

---

## Known Limitations

- **FFmpeg required for MP4 output.** Without FFmpeg, the worker concatenates raw `.webm` chunks without transcoding. The video is playable but unoptimized.
- **Chrome only.** The extension uses `chrome.debugger`, `tabCapture`, and `offscreen` — Chrome-exclusive APIs. Firefox and Safari are not supported.
- **Webcam overlay is client-side.** Webcam picture-in-picture during screen recording is rendered in the browser; the webcam video is not composited into the final video file.
- **Logs stored in metadata JSON.** Console logs and network requests are stored in `recording.metadata` as a JSON blob. The dedicated `consoleLogs` and `networkLogs` columns exist in the schema but are not currently populated separately.
- **No end-to-end encryption.** Recordings are stored in Cloudinary without client-side encryption. Access control is enforced at the application layer via `isPublic` and share tokens.
- **BigInt serialization.** Prisma returns `size` as `BigInt`. The backend applies a global JSON replacer (`app.set('json replacer', ...)`) to convert BigInt to string before sending responses. Redis `cacheSet` applies the same replacer. If you consume the API directly, `size` arrives as a numeric string.

---

## License

MIT © SnapTrace Contributors
