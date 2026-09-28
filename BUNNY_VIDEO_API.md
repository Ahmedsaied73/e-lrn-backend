# Bunny Stream Video Integration — API Reference & Operations Guide

This document describes the Bunny.net Stream video integration for the e-learning platform backend.

---

## 1. Architecture Overview

- **Storage & Encoding**: Bunny.net Stream Library
- **Upload Model**: Direct binary streaming (server-proxied without buffering)
- **Security**: Embed View Token Authentication (signed SHA-256 tokens)
- **Consistency**: AP Model — Eventual consistency via webhooks (primary) and scheduled reconciliation cron (fallback).
- **Separation of Concerns**: Standalone `BunnyVideo` Prisma model completely decoupled from existing `Video` / YouTube models.

---

## 2. Environment Variables

Configure these variables in your `.env` file:

| Variable | Description | Example / Default |
| :--- | :--- | :--- |
| `BUNNY_STREAM_LIBRARY_ID` | Numeric Bunny Stream Video Library ID | `123456` |
| `BUNNY_STREAM_API_KEY` | Full-access API Key for video CRUD & upload | `abc-123-...` |
| `BUNNY_STREAM_READ_ONLY_API_KEY` | Read-only API Key (also used for HMAC Webhook verification) | `ro-xyz-...` |
| `BUNNY_STREAM_TOKEN_KEY` | Token Authentication Key for signed player embeds | `sec-token-...` |
| `BUNNY_STREAM_TOKEN_TTL_SECONDS` | Signed embed token expiration (seconds) | `21600` (6 hours) |
| `BUNNY_VIDEO_MAX_BYTES` | Maximum allowed binary upload size | `5368709120` (5 GB) |

> [!IMPORTANT]
> In your Bunny.net dashboard under **Stream** > **[Your Library]** > **Security**, enable **"Embed View Token Authentication"** to enforce signed token validation.

---

## 3. Endpoints

### 3.1 Create Video Object
Creates a placeholder video in Bunny Stream and records a `PENDING` entry in the database.

- **Route**: `POST /courses/:courseId/videos`
- **Auth**: `Bearer <JWT>` (Admin only)
- **Headers**: `Content-Type: application/json`

#### Request Body
```json
{
  "title": "Module 1: Algebra Fundamentals"
}
```

#### Success Response (`201 Created`)
```json
{
  "success": true,
  "data": {
    "id": 14,
    "courseId": 3,
    "title": "Module 1: Algebra Fundamentals",
    "bunnyVideoId": "b1a2c3d4-e5f6-7890-abcd-ef1234567890",
    "status": "PENDING",
    "createdAt": "2026-08-14T00:00:00.000Z"
  }
}
```

#### Error Responses
- `400 Bad Request`: `{ "success": false, "error": "Video title is required", "code": "VALIDATION_ERROR" }`
- `404 Not Found`: `{ "success": false, "error": "Course not found", "code": "COURSE_NOT_FOUND" }`
- `502 Bad Gateway`: `{ "success": false, "error": "Failed to create video on Bunny Stream. Please try again.", "code": "BUNNY_API_ERROR" }`

---

### 3.2 Upload Video Binary (Streamed)
Streams a video file directly to Bunny Stream without disk buffering or memory hoarding.

- **Route**: `POST /videos/:videoId/upload`
- **Auth**: `Bearer <JWT>` (Admin only)
- **Headers**: `Content-Type: multipart/form-data`
- **Body**: Form-data with field name `video`
- **Allowed MIME Types**: `video/mp4`, `video/quicktime`, `video/x-matroska`, `video/x-msvideo`, `video/webm`

#### Success Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "videoId": 14,
    "status": "PROCESSING",
    "message": "Upload complete. Video is now encoding on Bunny Stream."
  }
}
```

#### Error Responses
- `400 Bad Request`: `{ "success": false, "error": "No \"video\" file field found in the request...", "code": "INVALID_VIDEO_FILE" }`
- `413 Payload Too Large`: `{ "success": false, "error": "File exceeds maximum allowed size (5368709120 bytes)", "code": "VIDEO_TOO_LARGE" }`
- `415 Unsupported Media Type`: `{ "success": false, "error": "File type not allowed...", "code": "INVALID_VIDEO_FILE" }`
- `422 Unprocessable Entity`: `{ "success": false, "error": "Cannot upload to a video in state: READY", "code": "INVALID_VIDEO_STATE" }`

---

### 3.3 Get Playback URL
Returns a secure signed embed iframe URL. Verifies course enrollment for students.

- **Route**: `GET /videos/:videoId/playback`
- **Auth**: `Bearer <JWT>` (Admin OR Enrolled Student)

#### Success Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "videoId": 14,
    "playbackUrl": "https://iframe.mediadelivery.net/embed/123456/b1a2c3d4-e5f6-7890-abcd-ef1234567890?token=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08&expires=1786687200",
    "expiresAt": 1786687200
  }
}
```

#### Error Responses
- `403 Forbidden`: `{ "success": false, "error": "You must be enrolled in this course to watch videos", "code": "VIDEO_ACCESS_DENIED" }`
- `404 Not Found`: `{ "success": false, "error": "Video not found", "code": "VIDEO_NOT_FOUND" }`
- `422 Unprocessable Entity`: `{ "success": false, "error": "Video is not ready for playback (current status: PROCESSING)", "code": "VIDEO_NOT_READY" }`

---

### 3.4 List Course Bunny Videos
Lists all Bunny videos associated with a course.

- **Route**: `GET /courses/:courseId/bunny-videos`
- **Auth**: `Bearer <JWT>` (Admin sees all statuses; Student sees `READY` videos only after enrollment check)

#### Success Response (`200 OK`)
```json
{
  "success": true,
  "data": [
    {
      "id": 14,
      "courseId": 3,
      "title": "Module 1: Algebra Fundamentals",
      "bunnyVideoId": "b1a2c3d4-e5f6-7890-abcd-ef1234567890",
      "status": "READY",
      "duration": 1840,
      "width": 1920,
      "height": 1080,
      "thumbnailUrl": "https://vz-123456.b-cdn.net/b1a2c3d4-e5f6-7890-abcd-ef1234567890/thumbnail.jpg",
      "createdAt": "2026-08-14T00:00:00.000Z"
    }
  ]
}
```

---

### 3.5 Delete Bunny Video
Deletes a video from Bunny Stream and removes its record from the database.

- **Route**: `DELETE /videos/bunny/:videoId`
- **Auth**: `Bearer <JWT>` (Admin only)

#### Success Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "id": 14,
    "bunnyVideoId": "b1a2c3d4-e5f6-7890-abcd-ef1234567890",
    "message": "Video successfully deleted from Bunny Stream and database."
  }
}
```

---

## 4. Webhook Handling (Internal)

- **Route**: `POST /webhooks/bunny/stream`
- **Security**: HMAC-SHA256 constant-time verification using `BUNNY_STREAM_READ_ONLY_API_KEY`
- **Required Headers**:
  - `X-BunnyStream-Signature`: HMAC SHA-256 hex digest of the raw body
  - `X-BunnyStream-Signature-Version`: `v1`
  - `X-BunnyStream-Signature-Algorithm`: `hmac-sha256`

### State Transitions on Webhook:
- Bunny Status `0` (Queued), `1` (Processing), `2` (Encoding) &rarr; `PROCESSING`
- Bunny Status `3` (Finished), `4` (Resolution Finished) &rarr; `READY` (populates duration, dimensions, thumbnail)
- Bunny Status `5` (Failed) &rarr; `FAILED` (records `failureReason`)

---

## 5. Background Reconciliation Job

- **Trigger**: Every 10 minutes (`node-cron`)
- **Action**: Queries videos in `PROCESSING` status older than 30 minutes, queries the Bunny API, and synchronizes the local database state.
