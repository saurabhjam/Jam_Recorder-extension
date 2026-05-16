# API Reference

Base URL: `http://localhost:5000/api`

All API responses use JSON. Authentication uses `Bearer` tokens in the `Authorization` header.

---

## Authentication

### POST /api/auth/register

Register a new user account.

**Request**

```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "password": "SecurePass123!"
}
```

**Response** `201 Created`

```json
{
  "user": {
    "id": "clx1234abcd",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "role": "USER",
    "avatarUrl": null,
    "createdAt": "2024-05-01T12:00:00.000Z"
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Errors**

| Status | Code                   | Description                 |
| ------ | ---------------------- | --------------------------- |
| 400    | `VALIDATION_ERROR`     | Missing or invalid fields   |
| 409    | `EMAIL_ALREADY_EXISTS` | Email is already registered |

---

### POST /api/auth/login

Authenticate and receive an access token.

**Request**

```json
{
  "email": "jane@example.com",
  "password": "SecurePass123!"
}
```

**Response** `200 OK`

```json
{
  "user": {
    "id": "clx1234abcd",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "role": "USER",
    "avatarUrl": null
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 604800
}
```

**Errors**

| Status | Code                  | Description             |
| ------ | --------------------- | ----------------------- |
| 401    | `INVALID_CREDENTIALS` | Wrong email or password |
| 404    | `USER_NOT_FOUND`      | Email not registered    |

---

### POST /api/auth/refresh

Refresh the access token using the `refreshToken` cookie.

**Response** `200 OK`

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

---

### POST /api/auth/logout

Invalidate the current session.

**Response** `200 OK`

```json
{ "message": "Logged out successfully" }
```

---

### GET /api/auth/me

Get the currently authenticated user.

**Headers**: `Authorization: Bearer <token>`

**Response** `200 OK`

```json
{
  "id": "clx1234abcd",
  "name": "Jane Doe",
  "email": "jane@example.com",
  "role": "USER",
  "avatarUrl": "https://res.cloudinary.com/.../avatar.jpg",
  "createdAt": "2024-05-01T12:00:00.000Z"
}
```

---

## Recordings

### GET /api/recordings

List recordings for the authenticated user.

**Headers**: `Authorization: Bearer <token>`

**Query Parameters**

| Parameter   | Type   | Default     | Description                               |
| ----------- | ------ | ----------- | ----------------------------------------- |
| `page`      | number | 1           | Page number                               |
| `limit`     | number | 20          | Items per page (max: 100)                 |
| `status`    | string | —           | Filter: `READY`, `PROCESSING`, `FAILED`   |
| `teamId`    | string | —           | Filter by team ID                         |
| `search`    | string | —           | Full-text search on title and description |
| `sortBy`    | string | `createdAt` | Sort field                                |
| `sortOrder` | string | `desc`      | `asc` or `desc`                           |

**Response** `200 OK`

```json
{
  "data": [
    {
      "id": "clx5678efgh",
      "title": "Bug reproduction – login form",
      "description": "Showing the validation error on step 2",
      "duration": 127,
      "status": "READY",
      "thumbnailUrl": "https://res.cloudinary.com/.../thumb.jpg",
      "videoUrl": "https://res.cloudinary.com/.../video.mp4",
      "viewCount": 5,
      "isPublic": false,
      "shareToken": "A3kP9xQzR7mB2wYvN1jL",
      "userId": "clx1234abcd",
      "teamId": "clxteam789",
      "createdAt": "2024-05-10T09:00:00.000Z",
      "updatedAt": "2024-05-10T09:05:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 42,
    "totalPages": 3,
    "hasNextPage": true,
    "hasPrevPage": false
  }
}
```

---

### GET /api/recordings/:id

Get a single recording by ID.

**Headers**: `Authorization: Bearer <token>`

**Response** `200 OK`

```json
{
  "id": "clx5678efgh",
  "title": "Bug reproduction – login form",
  "description": "Showing the validation error on step 2",
  "duration": 127,
  "status": "READY",
  "thumbnailUrl": "https://res.cloudinary.com/.../thumb.jpg",
  "videoUrl": "https://res.cloudinary.com/.../video.mp4",
  "cloudinaryPublicId": "snaptrace/recordings/recording-001",
  "viewCount": 5,
  "isPublic": false,
  "shareToken": "A3kP9xQzR7mB2wYvN1jL",
  "shareUrl": "http://localhost:3001/share/A3kP9xQzR7mB2wYvN1jL",
  "user": {
    "id": "clx1234abcd",
    "name": "Jane Doe",
    "avatarUrl": null
  },
  "team": {
    "id": "clxteam789",
    "name": "Acme Engineering"
  },
  "createdAt": "2024-05-10T09:00:00.000Z",
  "updatedAt": "2024-05-10T09:05:00.000Z"
}
```

**Errors**

| Status | Code        | Description                            |
| ------ | ----------- | -------------------------------------- |
| 403    | `FORBIDDEN` | Recording belongs to another user/team |
| 404    | `NOT_FOUND` | Recording not found                    |

---

### POST /api/recordings

Create a recording metadata entry (before upload).

**Headers**: `Authorization: Bearer <token>`

**Request**

```json
{
  "title": "My New Recording",
  "description": "Optional description",
  "teamId": "clxteam789",
  "isPublic": false
}
```

**Response** `201 Created`

```json
{
  "id": "clxnewrec123",
  "title": "My New Recording",
  "status": "PENDING",
  "shareToken": "Xk3pQ9zR7mB2wYvN1jLa",
  "createdAt": "2024-05-14T10:00:00.000Z"
}
```

---

### PATCH /api/recordings/:id

Update recording metadata.

**Headers**: `Authorization: Bearer <token>`

**Request** (all fields optional)

```json
{
  "title": "Updated Title",
  "description": "Updated description",
  "isPublic": true
}
```

**Response** `200 OK` — returns updated recording object.

---

### DELETE /api/recordings/:id

Delete a recording and remove it from Cloudinary.

**Headers**: `Authorization: Bearer <token>`

**Response** `200 OK`

```json
{ "message": "Recording deleted successfully" }
```

---

## Upload

### POST /api/recordings/upload/init

Initialize a chunked upload session.

**Headers**: `Authorization: Bearer <token>`, `Content-Type: application/json`

**Request**

```json
{
  "recordingId": "clxnewrec123",
  "filename": "recording.webm",
  "fileSize": 52428800,
  "mimeType": "video/webm",
  "totalChunks": 10
}
```

**Response** `200 OK`

```json
{
  "uploadId": "upload_abc123xyz",
  "chunkSize": 5242880,
  "expiresAt": "2024-05-14T11:00:00.000Z"
}
```

---

### POST /api/recordings/upload/chunk

Upload a single chunk.

**Headers**: `Authorization: Bearer <token>`, `Content-Type: multipart/form-data`

**Form Fields**

| Field        | Type   | Description                    |
| ------------ | ------ | ------------------------------ |
| `uploadId`   | string | Upload session ID from `/init` |
| `chunkIndex` | number | 0-based chunk index            |
| `chunk`      | file   | Binary chunk data              |

**Response** `200 OK`

```json
{
  "chunkIndex": 0,
  "received": true,
  "progress": 10
}
```

---

### POST /api/recordings/upload/finish

Finalize the upload; triggers background processing.

**Headers**: `Authorization: Bearer <token>`

**Request**

```json
{
  "uploadId": "upload_abc123xyz",
  "recordingId": "clxnewrec123"
}
```

**Response** `202 Accepted`

```json
{
  "recordingId": "clxnewrec123",
  "status": "PROCESSING",
  "message": "Recording queued for processing"
}
```

---

### POST /api/recordings/upload (simple single-file)

Direct single-file upload for small recordings (< 100 MB).

**Headers**: `Authorization: Bearer <token>`, `Content-Type: multipart/form-data`

**Form Fields**

| Field         | Type   | Required | Description           |
| ------------- | ------ | -------- | --------------------- |
| `video`       | file   | Yes      | Video file (webm/mp4) |
| `title`       | string | Yes      | Recording title       |
| `description` | string | No       | Optional description  |
| `teamId`      | string | No       | Associate with a team |
| `duration`    | number | No       | Duration in seconds   |

**Response** `201 Created`

```json
{
  "id": "clxnewrec124",
  "title": "My Recording",
  "status": "PROCESSING",
  "shareToken": "Xk3pQ9zR7mB2wYvN1jLa"
}
```

---

## Sharing

### GET /api/share/:shareToken

Access a public shared recording (no auth required).

**Response** `200 OK`

```json
{
  "id": "clx5678efgh",
  "title": "Bug reproduction – login form",
  "duration": 127,
  "videoUrl": "https://res.cloudinary.com/.../video.mp4",
  "thumbnailUrl": "https://res.cloudinary.com/.../thumb.jpg",
  "viewCount": 6,
  "createdAt": "2024-05-10T09:00:00.000Z",
  "author": {
    "name": "Jane Doe",
    "avatarUrl": null
  }
}
```

**Errors**

| Status | Code         | Description          |
| ------ | ------------ | -------------------- |
| 403    | `NOT_PUBLIC` | Recording is private |
| 404    | `NOT_FOUND`  | Invalid share token  |

---

### POST /api/recordings/:id/share

Generate or regenerate the share link for a recording.

**Headers**: `Authorization: Bearer <token>`

**Request**

```json
{
  "isPublic": true
}
```

**Response** `200 OK`

```json
{
  "shareToken": "Xk3pQ9zR7mB2wYvN1jLa",
  "shareUrl": "http://localhost:3001/share/Xk3pQ9zR7mB2wYvN1jLa",
  "isPublic": true
}
```

---

## Teams

### GET /api/teams

List all teams the authenticated user belongs to.

**Headers**: `Authorization: Bearer <token>`

**Response** `200 OK`

```json
{
  "data": [
    {
      "id": "clxteam789",
      "name": "Acme Engineering",
      "slug": "acme-engineering",
      "description": "Engineering team",
      "avatarUrl": null,
      "plan": "PRO",
      "memberCount": 5,
      "recordingCount": 42,
      "myRole": "ADMIN",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

---

### POST /api/teams

Create a new team.

**Headers**: `Authorization: Bearer <token>`

**Request**

```json
{
  "name": "My New Team",
  "description": "Optional description"
}
```

**Response** `201 Created`

```json
{
  "id": "clxteamnew",
  "name": "My New Team",
  "slug": "my-new-team",
  "plan": "FREE",
  "createdAt": "2024-05-14T10:00:00.000Z"
}
```

---

### GET /api/teams/:teamId/members

List team members.

**Headers**: `Authorization: Bearer <token>` (must be team member)

**Response** `200 OK`

```json
{
  "data": [
    {
      "id": "clxmember1",
      "user": {
        "id": "clx1234abcd",
        "name": "Jane Doe",
        "email": "jane@example.com",
        "avatarUrl": null
      },
      "role": "ADMIN",
      "joinedAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

---

### POST /api/teams/:teamId/invite

Invite a user to the team by email.

**Headers**: `Authorization: Bearer <token>` (must be ADMIN)

**Request**

```json
{
  "email": "colleague@example.com",
  "role": "MEMBER"
}
```

**Response** `200 OK`

```json
{
  "message": "Invitation sent to colleague@example.com",
  "inviteToken": "inv_xyz123"
}
```

---

### DELETE /api/teams/:teamId/members/:userId

Remove a member from the team.

**Headers**: `Authorization: Bearer <token>` (must be ADMIN)

**Response** `200 OK`

```json
{ "message": "Member removed from team" }
```

---

## Users

### GET /api/users/profile

Get authenticated user's full profile.

**Headers**: `Authorization: Bearer <token>`

**Response** `200 OK`

```json
{
  "id": "clx1234abcd",
  "name": "Jane Doe",
  "email": "jane@example.com",
  "role": "USER",
  "avatarUrl": null,
  "createdAt": "2024-05-01T12:00:00.000Z",
  "stats": {
    "totalRecordings": 12,
    "totalDuration": 3480,
    "totalViews": 87
  }
}
```

---

### PATCH /api/users/profile

Update user profile.

**Headers**: `Authorization: Bearer <token>`

**Request**

```json
{
  "name": "Jane Smith"
}
```

**Response** `200 OK` — returns updated user object.

---

### POST /api/users/avatar

Upload a profile avatar.

**Headers**: `Authorization: Bearer <token>`, `Content-Type: multipart/form-data`

**Form Fields**: `avatar` (image file, max 5 MB)

**Response** `200 OK`

```json
{
  "avatarUrl": "https://res.cloudinary.com/.../avatar.jpg"
}
```

---

## Health

### GET /health

Health check endpoint (no auth required). Used by Docker, load balancers.

**Response** `200 OK`

```json
{
  "status": "ok",
  "timestamp": "2024-05-14T10:00:00.000Z",
  "services": {
    "database": "ok",
    "redis": "ok"
  },
  "version": "1.0.0"
}
```

---

## Error Format

All errors follow a consistent shape:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {}
  }
}
```

### Common Error Codes

| HTTP Status | Code                  | Description                              |
| ----------- | --------------------- | ---------------------------------------- |
| 400         | `VALIDATION_ERROR`    | Request body or params failed validation |
| 401         | `UNAUTHORIZED`        | Missing or invalid access token          |
| 403         | `FORBIDDEN`           | Authenticated but not authorized         |
| 404         | `NOT_FOUND`           | Resource does not exist                  |
| 409         | `CONFLICT`            | Resource already exists                  |
| 413         | `PAYLOAD_TOO_LARGE`   | File exceeds 500 MB limit                |
| 422         | `UNPROCESSABLE`       | Semantically invalid request             |
| 429         | `RATE_LIMITED`        | Too many requests                        |
| 500         | `INTERNAL_ERROR`      | Unexpected server error                  |
| 503         | `SERVICE_UNAVAILABLE` | Database or external service is down     |

---

## WebSocket Events (Socket.IO)

Connect to `ws://localhost:5000` with the access token:

```js
const socket = io('http://localhost:5000', {
  auth: { token: accessToken },
});
```

### Events emitted by server

| Event                  | Payload                                   | Description                   |
| ---------------------- | ----------------------------------------- | ----------------------------- |
| `recording:processing` | `{ recordingId, progress: 0-100 }`        | Processing progress update    |
| `recording:ready`      | `{ recordingId, videoUrl, thumbnailUrl }` | Recording finished processing |
| `recording:failed`     | `{ recordingId, error: string }`          | Processing failed             |
| `recording:deleted`    | `{ recordingId }`                         | Recording deleted by user     |

### Events emitted by client

| Event             | Payload           | Description                       |
| ----------------- | ----------------- | --------------------------------- |
| `join:recording`  | `{ recordingId }` | Subscribe to a recording's events |
| `leave:recording` | `{ recordingId }` | Unsubscribe                       |
