# Quiz / Exam API — Complete Frontend Integration Guide

> Everything the frontend needs to integrate the quiz/exam feature: concepts, data model, every endpoint with request/response examples, error contracts, the sequential-gate behavior, and copy-paste integration flows.
>
> **Source of truth (backend):** `src/routes/quizRoutes.js` · `src/controllers/quizController.js` · `src/services/quizService.js` · `src/config/quizConfig.js` · `prisma/schema.prisma` · mounted in `app.js` at `/quizzes`.
> **Stack:** Express + Prisma (MySQL). Questions are defined as **SurveyJS JSON**.

## Table of Contents
1. [Big Picture](#1-big-picture)
2. [Conventions — Base URL, Auth, Envelope, Rate Limits](#2-conventions)
3. [Domain Model & Attempt Lifecycle](#3-domain-model--attempt-lifecycle)
4. [SurveyJS Payload Format (`surveyJson` + `answerKey`)](#4-surveyjs-payload-format)
5. [Endpoint Reference — Student](#5-endpoint-reference--student)
6. [Endpoint Reference — Admin](#6-endpoint-reference--admin)
7. [The Sequential Gate (quiz blocks the next video)](#7-the-sequential-gate)
8. [Frontend Integration Flows (code)](#8-frontend-integration-flows)
9. [Error Matrix (all codes, all endpoints)](#9-error-matrix)
10. [Checklist & Gotchas](#10-checklist--gotchas)
- [Appendix A — Server Constants](#appendix-a--server-constants)
- [Appendix B — TypeScript Types](#appendix-b--typescript-types)

---

## 1. Big Picture

| Concept | What it means |
|---|---|
| **Quiz** | Attached **1:1 to a video** (`videoId` unique). There are no course-level "final exams" in the current version — every quiz belongs to one lecture video. |
| **Question types** | `radiogroup` (single-answer MCQ, **auto-graded**), `comment` (essay, **admin-graded**), `html` / `image` (display-only, never scored). |
| **Answer key** | Correct values / model answers / points live **only** in the server-side `answerKey`. Students **never** receive them (stripped server-side). |
| **Timer** | Server-authoritative: `deadlineAt = startedAt + timeLimitSec` is stored at start. Late submits are rejected after a **10 s** network grace. Untimed quizzes allowed (`timeLimitSec: null`). |
| **Attempts** | Unlimited retakes. One live `IN_PROGRESS` attempt at a time (refresh-safe: it resumes with its original deadline). Best **GRADED** score counts. |
| **Passing** | `scorePercent ≥ passingScore` (default **50**, a percentage). |
| **Sequential gate** | Video *N+1* unlocks only when video *N* is completed **and** (video *N* has no quiz **or** best score ≥ passing score) — unless an **admin exemption** exists or the user is an admin. |
| **Roles** | JWT payload role: `STUDENT` or `ADMIN`. Admins bypass enrollment, video-completion and the gate. |

**Student journey:** complete video → quiz unlocks → `POST …/start` returns sanitized SurveyJS JSON + deadline → render with `survey-react-ui` → submit answers → MCQs auto-graded (`GRADED`) or essays queued (`GRADING`) → admin grades essays → `GET …/result` shows score + model answers → gate unlocks the next video.

**Two frontend surfaces:**
1. **Student player** — quiz card on the video page + `survey-react-ui` runner + result screen.
2. **Admin studio** — quiz authoring (`survey-creator` output split into `surveyJson` + `answerKey`), grading queue for essays, attempt resets, gate exemptions.

---

## 2. Conventions

### 2.1 Base URL
- Local dev: **`http://localhost:3005`** (env `PORT`, default `3005`).
- **No `/api` prefix.** Example full URL: `POST http://localhost:3005/quizzes/videos/42/start`.

### 2.2 Authentication
All `/quizzes/*` routes require a valid JWT. The backend accepts, in order:
1. HttpOnly cookie **`accessToken`** (set by `POST /auth/login`; legacy cookie name `token` also accepted), or
2. `Authorization: Bearer <jwt>` header.

JWT payload used by the API: `{ id: number, role: 'STUDENT' | 'ADMIN', ... }`.

> ⚠️ **Cookies + CORS:** the backend whitelists origins (`http://localhost:3000`, `http://127.0.0.1:3000`, `http://127.0.0.1:3002`, and `process.env.FRONTEND_URL`) with `credentials: true`. You **must** send credentials on every request.

```js
// api.js — single shared axios instance
import axios from 'axios';

export const api = axios.create({
  baseURL: import.meta.env?.VITE_API_URL ?? 'http://localhost:3005',
  withCredentials: true, // REQUIRED — sends the HttpOnly auth cookie cross-origin
});

// Optional: if you prefer Bearer tokens over cookies:
// api.interceptors.request.use(cfg => {
//   cfg.headers.Authorization = `Bearer ${localStorage.getItem('token')}`;
//   return cfg;
// });
```

Auth failures (all endpoints):

| Code | Body |
|---|---|
| `401` | `{ "success": false, "error": "Access denied. No token provided." }` |
| `401` | `{ "success": false, "error": "Invalid or expired token." }` |
| `403` (admin routes) | `{ "success": false, "error": "Access denied. Insufficient privileges." }` |

### 2.3 Response envelope
**Every** quiz endpoint uses:

```jsonc
// success
{ "success": true, "message": "optional human message", "data": { ... } }

// error
{ "success": false, "error": "Human-readable message", "details": ["validation detail", "..."] }
//                                                                 ^ details[] only on validation errors
```

> ⚠️ **Exception:** the sequential-gate `403`s returned by the *streaming / next-video* endpoints use a different shape `{ "message": ... }` — see [§7](#7-the-sequential-gate).

### 2.4 Formats & limits
- Dates: **ISO-8601 UTC** strings, e.g. `"2026-09-03T10:00:00.000Z"`.
- IDs: integers.
- `scorePercent`: number 0–100 rounded to 2 decimals.
- Rate limiting: **100 requests / 15 min / IP** globally → `429` with `{ "message": "Too many requests from this IP, please try again later." }`. Don't poll `meta` in a tight loop — refetch it when the video completes.

---

## 3. Domain Model & Attempt Lifecycle

### 3.1 `Quiz` — one per video
| Field | Type | Notes |
|---|---|---|
| `id` | int | PK — used in `DELETE /quizzes/:quizId` and `GET /quizzes/:quizId/attempts` |
| `videoId` | int | **unique** — one quiz per video |
| `title` | string | |
| `timeLimitSec` | int \| null | `null` = untimed |
| `passingScore` | int | default `50` (percentage) |
| `surveyJson` | JSON | student-facing SurveyJS definition (no secrets) |
| `answerKey` | JSON | **server-only** — never returned to students |

### 3.2 `QuizAttempt`
| Field | Type | Notes |
|---|---|---|
| `id` | int | PK — used in submit / result / reset / grade URLs |
| `quizId`, `userId` | int | owner; **not** unique per user (multi-attempt) |
| `attemptNumber` | int | 1, 2, 3… increments per retake |
| `status` | enum | see lifecycle below |
| `startedAt` | datetime | |
| `deadlineAt` | datetime \| null | server timer; `null` when untimed |
| `submittedAt` | datetime \| null | |
| `autoSubmitted` | bool | `true` when submitted by timeout |
| `responses` | JSON \| null | `{ [qName]: value }` |
| `mcqEarned` / `essayEarned` | int \| null | |
| `earnedPoints` / `totalPoints` | int \| null | |
| `scorePercent` | float \| null | 0–100 |
| `essayFeedback` | JSON \| null | `{ [qName]: { awarded, max, feedback } }` |
| `essayGradedBy` / `essayGradedAt` | int / datetime \| null | |

**Status enum (`QuizAttemptStatus`):** `IN_PROGRESS · SUBMITTED · GRADING · GRADED · EXPIRED`

> ℹ️ `SUBMITTED` exists in the enum but is **never written** by the current flow. Treat `GRADING` as "submitted — essays awaiting admin review".

### 3.3 Attempt lifecycle

```
        POST /videos/:videoId/start
        (resumes if a live IN_PROGRESS attempt exists)
                    │
                    ▼
              IN_PROGRESS ───────────────► EXPIRED
                    │                      (now > deadlineAt + 10s grace;
                    │ submit                detected on submit OR lazily
                    ▼                      on the next start; score = 0)
        ┌──── has essay questions? ────┐
        ▼ no                           ▼ yes
     GRADED                         GRADING ── PUT /attempts/:id/grade ──► GRADED
 (final score)                   (MCQ points only; essays pending)
```

Rules encoded in the backend:
- **Resume:** `start` returns the existing `IN_PROGRESS` attempt with its **original** `deadlineAt` and `resumed: true` — refreshing the page does **not** reset the timer.
- **Lazy expiry:** an overdue `IN_PROGRESS` attempt is flipped to `EXPIRED` (score 0) the next time the student hits `start`; a fresh attempt is then created.
- **Double submit:** a second submit on a non-`IN_PROGRESS` attempt → `409`.
- **Best score:** `bestScore = max(scorePercent)` across **GRADED** attempts; `passed = bestScore ≥ passingScore`.

### 3.4 `GateExemption` — admin override
| Field | Value |
|---|---|
| `id` | int PK — used in `DELETE /quizzes/exemptions/:exemptionId` |
| `userId` | student who is exempted |
| `videoId` | the video **owning the blocking quiz** (= the previous video in sequence) |
| `grantedBy` | admin user id |
| `reason` | optional free text |

Unique per `(userId, videoId)`. An exemption bypasses **both** the previous-video-completion check and the quiz-pass check for that gate.

---

## 4. SurveyJS Payload Format

The backend stores two JSON documents per quiz. Admin frontends produce both; the student frontend consumes only `surveyJson`.

### 4.1 `surveyJson` — student-facing definition
Rules enforced by the backend on `POST /quizzes/videos/:videoId`:
- Serialized size ≤ **256 KB**.
- Must contain `pages: []` with **at least one page** having `elements`.
- Every scorable element needs a **unique `name`** — it becomes the key in `answers`, `answerKey`, and per-question results.
- Allowed element **types**: `radiogroup`, `comment`, `html`, `image` — anything else is rejected.
- **Never** embed correct answers or points inside `surveyJson`.

```jsonc
{
  "title": "Lesson 1 Quiz",
  "pages": [
    {
      "name": "page1",
      "elements": [
        { "type": "radiogroup", "name": "q1", "title": "What is 2 + 2?",
          "choices": ["3", "4", "5"], "isRequired": true },
        { "type": "comment", "name": "q2", "title": "Explain photosynthesis." },
        { "type": "html", "name": "intro", "html": "<b>Good luck!</b>" }
      ]
    }
  ]
}
```

### 4.2 `answerKey` — server-side grading key (admin input)
```jsonc
{
  "q1": { "type": "radiogroup", "correctValue": "4",  "points": 5 },
  "q2": { "type": "comment",   "modelAnswer": "Photosynthesis is the process by which…", "points": 10 }
}
```
Backend validation (violations returned in `details[]`):
- Every scorable question in `surveyJson` must have an entry (`html`/`image` excluded).
- `points` must be a **positive number**.
- `radiogroup` → `correctValue` required. `comment` → `modelAnswer` required.

### 4.3 What students see vs. what stays server-side

| Data | Student sees | Where |
|---|---|---|
| `surveyJson` | ✅ | on `start` (sanitized) |
| `answerKey` | ❌ never | stripped by `sanitizeForStudent()` |
| `correctAnswer` per MCQ | ✅ **only after submit** | `GET /attempts/:id/result` |
| `modelAnswer` per essay | ✅ **only after submit** | `GET /attempts/:id/result` |
| points per question | ❌ pre-submit | only `earnedPoints`/`maxPoints` post-submit |

---

## 5. Endpoint Reference — Student

All student endpoints live under `/quizzes` and require authentication (cookie or Bearer). Permission checks are performed by role from the JWT.

---

### 5.1 `GET /quizzes/videos/:videoId/meta`

Drives the quiz card / **"بدء الاختبار"** button: does a quiz exist, is it unlocked, did the student pass, is there a live attempt to resume?

- **Auth:** any logged-in user (students must be enrolled in the course; admins bypass).
- **Path params:** `videoId` (integer).

**`200 OK` — quiz exists:**
```json
{
  "success": true,
  "data": {
    "exists": true,
    "quizId": 7,
    "videoId": 42,
    "videoTitle": "Lecture 3 — Async JS",
    "title": "Lecture 3 Quiz",
    "timeLimitSec": 600,
    "passingScore": 50,
    "unlocked": true,
    "attempted": true,
    "totalAttempts": 2,
    "passed": true,
    "bestScore": 83.33,
    "inProgressAttempt": {
      "id": 104,
      "attemptNumber": 3,
      "deadlineAt": "2026-09-03T10:05:00.000Z"
    }
  }
}
```

| Field | Meaning |
|---|---|
| `unlocked` | student has **completed the video** (always `true` for admins) |
| `attempted` / `totalAttempts` | any attempt rows exist / how many |
| `bestScore` | max `scorePercent` across **GRADED** attempts (`null` if none) |
| `passed` | `bestScore ≥ passingScore` |
| `inProgressAttempt` | live attempt to resume — show a countdown from its `deadlineAt`; `null` if none |

**`200 OK` — no quiz on this video:**
```json
{ "success": true, "data": { "exists": false, "videoId": 42, "videoTitle": "Lecture 3 — Async JS" } }
```

**Errors:**

| Code | Body |
|---|---|
| `400` | `{ "success": false, "error": "Invalid video ID" }` |
| `403` | `{ "success": false, "error": "You are not enrolled in this course" }` |
| `404` | `{ "success": false, "error": "Video not found" }` |
| `500` | `{ "success": false, "error": "Internal server error" }` |

> ℹ️ `meta` does **not** block on video completion — it *reports* it via `unlocked` so the UI can disable the button. The `start` endpoint enforces it with `403`.

---

### 5.2 `POST /quizzes/videos/:videoId/start`

Starts a **new** attempt or **resumes** the live one. Returns the sanitized SurveyJS definition + the server deadline.

- **Body:** none (send `{}` or omit).
- **Behavior (students):** requires enrollment **and** a completed video. Admins skip both.
- Live `IN_PROGRESS` attempt → returned with `resumed: true` and its **original** `deadlineAt`.
- Overdue `IN_PROGRESS` attempt → marked `EXPIRED` (score 0), then a fresh attempt is created.

**`200 OK` (new attempt):**
```json
{
  "success": true,
  "data": {
    "attemptId": 105,
    "attemptNumber": 4,
    "status": "IN_PROGRESS",
    "startedAt": "2026-09-03T09:55:00.000Z",
    "deadlineAt": "2026-09-03T10:05:00.000Z",
    "resumed": false,
    "quiz": {
      "id": 7,
      "videoId": 42,
      "title": "Lecture 3 Quiz",
      "timeLimitSec": 600,
      "passingScore": 50,
      "surveyJson": { "title": "Lecture 3 Quiz", "pages": [ "…survey definition…" ] }
    }
  }
}
```
For a **resumed** attempt the same shape returns with `resumed: true`, the original `startedAt` / `deadlineAt`, and the same `attemptNumber`.

**Errors:**

| Code | Body |
|---|---|
| `400` | `{ "success": false, "error": "Invalid video ID" }` |
| `403` | `{ "success": false, "error": "You are not enrolled in this course" }` |
| `403` | `{ "success": false, "error": "You must complete the video before taking the quiz" }` |
| `404` | `{ "success": false, "error": "No quiz found for this video" }` |
| `500` | `{ "success": false, "error": "Internal server error" }` |

---

### 5.3 `POST /quizzes/attempts/:id/submit`

Submits the answer map. MCQs are auto-graded immediately; essays queue the attempt for admin review. The server enforces the deadline.

- **Path params:** `id` — the `attemptId` from `start`.
- **Body:**
```json
{
  "answers": { "q1": "4", "q2": "Photosynthesis is…" },
  "autoSubmitted": false
}
```
- `answers` (**required**, object): keys are SurveyJS question `name`s, values exactly what `survey.data` contains (choice **value** for `radiogroup`, free text for `comment`). Unanswered questions may simply be absent.
- `autoSubmitted` (optional bool): send `true` when the client timer fired — stored for reporting.

**Deadline rule:** if `now > deadlineAt + 10s grace`, the attempt is marked `EXPIRED` with score 0 and the submit is rejected with `403`.
**Double submit:** submitting an attempt that is no longer `IN_PROGRESS` → `409`.

**`200 OK`:**
```json
{
  "success": true,
  "data": {
    "attemptId": 105,
    "status": "GRADING",
    "earnedPoints": 5,
    "totalPoints": 15,
    "scorePercent": 33.33,
    "hasEssays": true,
    "perQuestion": [
      { "qName": "q1", "isCorrect": true, "earned": 5, "max": 5 }
    ]
  }
}
```

| Field | Meaning |
|---|---|
| `status` | `GRADED` = final (quiz had no essays). `GRADING` = MCQ points only; essays await admin grading. |
| `scorePercent` | provisional when `GRADING` (MCQ earned ÷ total points incl. essay points) |
| `hasEssays` | if `true`, show a "pending review" screen — the final score arrives after admin grading |
| `perQuestion` | MCQ-only breakdown: `qName`, `isCorrect`, `earned`, `max` |

**Errors:**

| Code | Body |
|---|---|
| `400` | `{ "success": false, "error": "Invalid attempt ID" }` |
| `400` | `{ "success": false, "error": "answers must be an object map of question responses" }` |
| `403` | `{ "success": false, "error": "Forbidden" }` — attempt belongs to another user |
| `403` | `{ "success": false, "error": "Submission deadline has passed. Attempt expired." }` — attempt is now `EXPIRED` |
| `404` | `{ "success": false, "error": "Attempt not found" }` |
| `409` | `{ "success": false, "error": "Attempt is already GRADED" }` (message interpolates the actual status: `GRADING` / `EXPIRED` / `SUBMITTED`) |

---

### 5.4 `GET /quizzes/attempts/:id/result`

Full score breakdown **with correct / model answers** — only available after submission. Accessible to the attempt owner and admins (admins use it in the grading flow too).

**`200 OK`:**
```json
{
  "success": true,
  "data": {
    "attemptId": 105,
    "attemptNumber": 4,
    "status": "GRADED",
    "startedAt": "2026-09-03T09:55:00.000Z",
    "submittedAt": "2026-09-03T10:02:11.000Z",
    "autoSubmitted": false,
    "earnedPoints": 13,
    "totalPoints": 15,
    "scorePercent": 86.67,
    "passed": true,
    "passingScore": 50,
    "questions": [
      {
        "name": "q1", "type": "radiogroup",
        "studentAnswer": "4", "correctAnswer": "4",
        "isCorrect": true, "earnedPoints": 5, "maxPoints": 5
      },
      {
        "name": "q2", "type": "comment",
        "studentAnswer": "Photosynthesis is…",
        "modelAnswer": "Photosynthesis is the process by which…",
        "earnedPoints": 8, "maxPoints": 10,
        "feedback": "Good — mention chlorophyll next time.",
        "status": "GRADED"
      }
    ]
  }
}
```

- Essay items in a not-yet-graded (`GRADING`) attempt look like: `"earnedPoints": null`, `"feedback": null`, `"status": "PENDING_REVIEW"`.
- `passed` is computed as `(scorePercent ?? 0) ≥ passingScore`.

**Errors:**

| Code | Body |
|---|---|
| `400` | `{ "success": false, "error": "Invalid attempt ID" }` |
| `400` | `{ "success": false, "error": "Quiz attempt is still in progress" }` — call `submit` first |
| `403` | `{ "success": false, "error": "Forbidden" }` — not your attempt (and you're not admin) |
| `404` | `{ "success": false, "error": "Attempt not found" }` |
| `500` | `{ "success": false, "error": "Internal server error" }` |

---

### 5.5 `GET /quizzes/videos/:videoId/attempts`

Attempt history for the logged-in student on this video's quiz.

**`200 OK`:**
```json
{
  "success": true,
  "data": {
    "quizId": 7,
    "title": "Lecture 3 Quiz",
    "passingScore": 50,
    "attempts": [
      { "id": 105, "attemptNumber": 4, "status": "GRADED", "startedAt": "…", "submittedAt": "…",
        "scorePercent": 86.67, "earnedPoints": 13, "totalPoints": 15, "autoSubmitted": false },
      { "id": 101, "attemptNumber": 3, "status": "EXPIRED", "startedAt": "…", "submittedAt": null,
        "scorePercent": 0, "earnedPoints": 0, "totalPoints": 15, "autoSubmitted": false }
    ]
  }
}
```
(ordered by `attemptNumber` descending)

**Errors:** `400 Invalid video ID` · `404 Quiz not found` · `500 Internal server error`.

---

## 6. Endpoint Reference — Admin

All admin endpoints additionally run `authorizeAdmin()` — non-admins get:
`403 { "success": false, "error": "Access denied. Insufficient privileges." }`

---

### 6.1 `POST /quizzes/videos/:videoId` — create / replace quiz definition

Upserts (one quiz per video). Re-POSTing for the same video **replaces** `title`, `timeLimitSec`, `passingScore`, `surveyJson` and `answerKey` (existing attempts are kept).

- **Body:**
```json
{
  "title": "Lecture 3 Quiz",
  "timeLimitSec": 600,
  "passingScore": 50,
  "surveyJson": { "pages": [ { "name": "page1", "elements": [
    { "type": "radiogroup", "name": "q1", "title": "What is 2 + 2?", "choices": ["3","4","5"] },
    { "type": "comment", "name": "q2", "title": "Explain photosynthesis." }
  ] } ] },
  "answerKey": {
    "q1": { "type": "radiogroup", "correctValue": "4", "points": 5 },
    "q2": { "type": "comment", "modelAnswer": "Photosynthesis is…", "points": 10 }
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `title` | ✅ | non-empty string |
| `timeLimitSec` | — | omit/null → **untimed** |
| `passingScore` | — | defaults to **50**; must be ≥ 1 (`0` is coerced to 50) |
| `surveyJson` | ✅ | validated — see §4.1 |
| `answerKey` | ✅ | validated — see §4.2 |

**`200 OK`:**
```json
{
  "success": true,
  "message": "Quiz saved successfully",
  "data": {
    "id": 7, "videoId": 42, "title": "Lecture 3 Quiz",
    "timeLimitSec": 600, "passingScore": 50,
    "surveyJson": { "…": "…" }
  }
}
```
> `data` is the **sanitized** quiz — `answerKey` is intentionally excluded from the response.

**Validation errors — `400` with `details[]`:**
```json
{
  "success": false,
  "error": "Invalid surveyJson definition",
  "details": [
    "Question type \"checkbox\" is not allowed. Allowed types: radiogroup, comment, html, image",
    "Duplicate question name: \"q1\""
  ]
}
```

| `error` value | When |
|---|---|
| `Title is required` | missing / empty title |
| `Invalid surveyJson definition` + `details` | size > 256 KB · no pages · disallowed type · missing/duplicate `name` |
| `answerKey object is required` | key missing |
| `Invalid answerKey` + `details` | entry missing per scorable question · `points` not > 0 · `correctValue` missing (MCQ) · `modelAnswer` missing (essay) |
| `Video not found` (`404`) | bad `videoId` |

---

### 6.2 `DELETE /quizzes/:quizId`

Deletes the quiz **and all its attempts** (DB cascade).

`200 { "success": true, "message": "Quiz deleted successfully" }`
Errors: `400 Invalid quiz ID` · `404 Quiz not found`.

---

### 6.3 `GET /quizzes/:quizId/attempts?status=GRADING` — grading queue

Lists attempts for a quiz with the **full attempt row** (including `responses` and `essayFeedback`) plus `user { id, name, email }`. Ordered by `startedAt` desc.

- **Query:** optional `status` filter — exact enum value, e.g. `GRADING` (grading queue), `GRADED`, `EXPIRED`, `IN_PROGRESS`.

**`200 OK` (trimmed example):**
```json
{
  "success": true,
  "data": [
    {
      "id": 105, "quizId": 7, "userId": 12, "attemptNumber": 4,
      "status": "GRADING",
      "startedAt": "…", "deadlineAt": "…", "submittedAt": "…",
      "autoSubmitted": false,
      "responses": { "q1": "4", "q2": "Photosynthesis is…" },
      "mcqEarned": 5, "essayEarned": 0, "earnedPoints": 5, "totalPoints": 15,
      "scorePercent": 33.33, "essayFeedback": null,
      "user": { "id": 12, "name": "Sara Ali", "email": "sara@example.com" }
    }
  ]
}
```

> To render essay questions together with the **model answers and max points**, also call `GET /quizzes/attempts/:id/result` (§5.4) as admin for each attempt — the queue rows don't include the `answerKey`.

---

### 6.4 `PUT /quizzes/attempts/:id/grade` — grade essays

Finalizes a `GRADING` attempt.

- **Body:**
```json
{
  "essayScores":   { "q2": 8 },
  "essayFeedback": { "q2": "Good — mention chlorophyll next time." }
}
```
- `essayScores` (**required**): `{ [qName]: awardedPoints }`. Only entries whose answer-key type is `comment` are counted; awards are **clamped to `0…points`**.
- `essayFeedback` (optional): `{ [qName]: string }`.

**`200 OK`:**
```json
{
  "success": true,
  "message": "Attempt graded successfully",
  "data": {
    "id": 105, "status": "GRADED",
    "mcqEarned": 5, "essayEarned": 8, "earnedPoints": 13, "totalPoints": 15,
    "scorePercent": 86.67,
    "essayFeedback": { "q2": { "awarded": 8, "max": 10, "feedback": "Good — mention chlorophyll next time." } },
    "essayGradedBy": 1, "essayGradedAt": "…"
  }
}
```

**Errors:** `400 Invalid attempt ID` · `400 essayScores object is required` · `404 Attempt not found` · `409 { "error": "Attempt status is \"GRADED\", expected GRADING" }` · `500`.

---

### 6.5 `POST /quizzes/attempts/:id/reset` — manual reset

Deletes the attempt so the student can retake the quiz (next attempt number = previous max + 1).
⚠️ If this was the student's only **passing** attempt, the gate re-locks them.

`200 { "success": true, "message": "Attempt reset successfully" }`
Errors: `400 Invalid attempt ID` · `404 Attempt not found`.

---

### 6.6 `POST /quizzes/videos/:videoId/exemptions` — grant gate exemption

Force-advances a student past the gate that belongs to `videoId`'s quiz (i.e., `videoId` = the video **owning the blocking quiz** = the previous video in sequence).

- **Body:** `{ "userId": 12, "reason": "Technical issue during exam" }`
- Upsert per `(userId, videoId)` — re-granting updates `reason` / `grantedBy`.

**`200 OK`:**
```json
{
  "success": true,
  "message": "Gate exemption granted successfully",
  "data": { "id": 3, "userId": 12, "videoId": 42, "grantedBy": 1,
            "reason": "Technical issue during exam", "createdAt": "…" }
}
```
Error: `400 { "success": false, "error": "videoId and userId are required" }`.

Effect: the student can access the **next** video without completing the previous one / passing its quiz.

---

### 6.7 `DELETE /quizzes/exemptions/:exemptionId` — revoke

`200 { "success": true, "message": "Exemption revoked successfully" }`
⚠️ Revoking a **non-existent** id returns **`500`** (not 404) — treat any `500` here as "already gone".

---

## 7. The Sequential Gate

The quiz pass is part of the **sequential learning gate**, evaluated by `quizService.evaluateGate()`. It affects endpoints the frontend already calls for playback and navigation:

| Endpoint | Guard |
|---|---|
| `GET /stream/video/:videoId/url` | `checkVideoAccess` + `ensureSequentialAccess` |
| `GET /stream/video/:videoId/embed` | `checkVideoAccess` + `ensureSequentialAccess` |
| `GET /stream/videos/:videoId/next` | gate evaluated inside the controller |

### 7.1 The rule

Access to video *N* (for students) is allowed iff:

```
user is ADMIN
OR N is the first video of the course
OR a gate exemption exists for (user, previousVideo)
OR ( previousVideo is completed
     AND ( previousVideo has NO quiz
           OR best GRADED attempt on that quiz ≥ its passingScore ) )
```

> Only **`GRADED`** attempts count. A `GRADING` attempt (essays pending admin review) does **not** unlock the next video.

### 7.2 The `403` payloads (note: `message`, not `success`/`error`)

**Blocked by quiz — streaming endpoints (`/stream/video/:id/url`, `/embed`):**
```json
{
  "message": "You must pass the quiz for the previous video before proceeding",
  "previousVideoId": 41,
  "quizId": 7,
  "yourScore": 33.33,
  "requiredScore": 50
}
```
**Blocked by quiz — next-video endpoint (`/stream/videos/:id/next`):**
```json
{
  "message": "You must complete and pass the quiz for the previous video before proceeding",
  "currentVideoId": 41,
  "quizId": 7,
  "yourScore": null,
  "requiredScore": 50
}
```

| Key | Meaning |
|---|---|
| `previousVideoId` / `currentVideoId` | the video whose quiz is blocking (use it to deep-link the quiz panel) |
| `quizId` | the blocking quiz |
| `yourScore` | best **GRADED** score — `null` when the student has no graded attempt yet |
| `requiredScore` | that quiz's `passingScore` |

Possible gate `message` values:
- `"You must complete the previous video before accessing this one"` (no `quizId`/score keys present)
- `"You must complete and pass the quiz for the previous video before proceeding"` (no graded attempt → `yourScore: null`)
- `"You must pass the quiz for the previous video before proceeding"` (graded but below required)

> ℹ️ The streaming middleware can also return unrelated `403`s (enrollment, **assignment** not submitted / pending / rejected — those include `assignmentId` instead of `quizId`). Distinguish quiz-gate blocks by the presence of `quizId`.

### 7.3 Frontend recipe

```js
try {
  const { data } = await api.get(`/stream/video/${videoId}/url`);
  // play…
} catch (err) {
  const body = err.response?.data;
  if (err.response?.status === 403 && body?.quizId !== undefined) {
    // quiz-gate block → open the quiz panel for body.previousVideoId / body.quizId
    // show: body.message + "your best score: body.yourScore / required: body.requiredScore"
  } else if (err.response?.status === 403) {
    // enrollment or assignment gate — body.message explains what to do
  }
}
```

---

## 8. Frontend Integration Flows (code)

### 8.1 Student — take a quiz (`survey-react-ui`)

```bash
npm i survey-core survey-react-ui
```

```tsx
// QuizPanel.tsx
import { useEffect, useState } from 'react';
import { Model } from 'survey-core';
import { Survey } from 'survey-react-ui';
import 'survey-core/defaultV2.min.css';
import { api } from './api';

export function QuizPanel({ videoId, onFinished }) {
  const [meta, setMeta] = useState(null);
  const [session, setSession] = useState(null); // { attemptId, survey }

  // 1) metadata — refetch when the video completes to flip `unlocked`
  useEffect(() => {
    api.get(`/quizzes/videos/${videoId}/meta`)
       .then(r => setMeta(r.data.data))
       .catch(() => setMeta({ exists: false }));
  }, [videoId]);

  // 2) start / resume
  const startQuiz = async () => {
    const { data } = await api.post(`/quizzes/videos/${videoId}/start`, {});
    const { attemptId, deadlineAt, quiz } = data.data;

    const survey = new Model(quiz.surveyJson);

    // 3) client countdown derived from the SERVER deadline (resume-safe)
    if (quiz.timeLimitSec && deadlineAt) {
      survey.maxTimeToFinish = Math.max(0,
        Math.floor((new Date(deadlineAt).getTime() - Date.now()) / 1000));
      // SurveyJS auto-completes the survey when the timer hits 0
    }

    // 4) submit
    survey.onComplete.add(async (sender) => {
      const autoSubmitted =
        !!sender.maxTimeToFinish && sender.timeSpent >= sender.maxTimeToFinish;
      try {
        const res = await api.post(`/quizzes/attempts/${attemptId}/submit`, {
          answers: sender.data,
          autoSubmitted,
        });
        onFinished?.(res.data.data); // GRADED → results; GRADING → "pending review"
      } catch (err) {
        const code = err.response?.status;
        if (code === 403 || code === 409) { // expired / already closed
          const r = await api.get(`/quizzes/attempts/${attemptId}/result`).catch(() => null);
          onFinished?.(r?.data?.data ?? null);
        }
      }
    });

    setSession({ attemptId, survey });
  };

  if (!meta?.exists) return null;
  if (session) return <Survey model={session.survey} />;

  return (
    <div className="quiz-card">
      <h3>{meta.title}</h3>
      <p>Best: {meta.bestScore ?? '—'} · Required: {meta.passingScore}% · Attempts: {meta.totalAttempts}</p>
      {meta.inProgressAttempt && (
        <CountdownTo deadline={meta.inProgressAttempt.deadlineAt} />
      )}
      <button disabled={!meta.unlocked} onClick={startQuiz}>
        {meta.attempted ? 'إعادة الاختبار' : 'بدء الاختبار'}
      </button>
      {!meta.unlocked && <small>Finish the video to unlock the quiz.</small>}
      {meta.attempted && !meta.passed && (
        <small>Pass with {meta.passingScore}% to unlock the next lecture.</small>
      )}
    </div>
  );
}
```

**Result screen (after submit):**
```tsx
const { data } = await api.get(`/quizzes/attempts/${attemptId}/result`);
const r = data.data;
// r.status === 'GRADING' → "Submitted! essays are being reviewed" (score provisional)
// r.status === 'GRADED'  → show r.scorePercent, r.passed, then per-question review:
r.questions.forEach(q => {
  // radiogroup: q.studentAnswer vs q.correctAnswer · q.isCorrect · q.earnedPoints / q.maxPoints
  // comment:    q.studentAnswer vs q.modelAnswer · q.feedback
  //             q.status === 'PENDING_REVIEW' | 'GRADED'
});
```

### 8.2 Resume behavior — what the UI must honor
- Refreshing mid-quiz must **re-`start`**: it returns the same attempt with `resumed: true` and the original `deadlineAt`. Derive the countdown from `deadlineAt - now`, never from a local `timeLimitSec` countdown.
- If `meta.inProgressAttempt` exists, show "quiz in progress" + countdown on the card.
- `deadlineAt: null` → untimed quiz (no countdown).
- Expired attempts surface as `403` on submit — route to the result/history screen, then offer a new attempt via `start`.

---

### 8.3 Admin — authoring a quiz (split `survey-creator` output)

`survey-creator` produces one JSON. The backend needs it split into `surveyJson` (layout, no secrets) + `answerKey` (correct values / model answers / points). Collect per-question grading data in your admin form, then:

```js
function buildQuizPayload(creatorJson, keyForm) {
  // keyForm: { [qName]: { correctValue?, modelAnswer?, points } } — from your admin UI
  const surveyJson = { title: creatorJson.title, pages: [] };
  const answerKey = {};

  for (const page of creatorJson.pages ?? []) {
    const elements = [];
    for (const el of page.elements ?? []) {
      if (el.type === 'radiogroup' || el.type === 'comment') {
        if (!keyForm[el.name]) throw new Error(`Missing grading data for "${el.name}"`);
        answerKey[el.name] = el.type === 'radiogroup'
          ? { type: 'radiogroup', correctValue: keyForm[el.name].correctValue, points: keyForm[el.name].points }
          : { type: 'comment',   modelAnswer:  keyForm[el.name].modelAnswer,  points: keyForm[el.name].points };
        elements.push(el.type === 'radiogroup'
          ? { type: el.type, name: el.name, title: el.title, choices: el.choices }
          : { type: el.type, name: el.name, title: el.title });
      } else if (el.type === 'html' || el.type === 'image') {
        elements.push(el); // display-only, not scored
      } else {
        throw new Error(`Unsupported question type "${el.type}"`);
      }
    }
    surveyJson.pages.push({ name: page.name, elements });
  }
  return { surveyJson, answerKey };
}

// Save:
await api.post(`/quizzes/videos/${videoId}`, {
  title: 'Lecture 3 Quiz',
  timeLimitSec: 600,          // or omit → untimed
  passingScore: 50,           // or omit → 50
  ...buildQuizPayload(creator.JSON, keyForm),
});
// 400 responses carry details[] — render each entry next to the creator.
```

---

### 8.4 Admin — grading queue workflow

```js
// 1) fetch the queue (essays awaiting review)
const { data: queue } = await api.get(`/quizzes/${quizId}/attempts`, {
  params: { status: 'GRADING' },
});

for (const attempt of queue.data) {
  // 2) per attempt, fetch the review payload (essay text + model answer + max points)
  const { data: detail } = await api.get(`/quizzes/attempts/${attempt.id}/result`);
  const essays = detail.data.questions.filter(q => q.type === 'comment');
  // render: essays[i].studentAnswer · essays[i].modelAnswer · maxPoints
}

// 3) submit grades for one attempt
await api.put(`/quizzes/attempts/${attemptId}/grade`, {
  essayScores:   { q2: 8 },                                  // 0…maxPoints, clamped server-side
  essayFeedback: { q2: 'Good — mention chlorophyll next time.' },
});
// After grading: student's result endpoint shows final score + feedback.
```

---

### 8.5 Admin — exemptions & resets

```js
// Force-advance a student blocked by the gate (from the 403 payload: quizId → its videoId)
await api.post(`/quizzes/videos/${blockingVideoId}/exemptions`, {
  userId: studentId,
  reason: 'Technical issue during exam',
});
// Revoke later:
await api.delete(`/quizzes/exemptions/${exemptionId}`);

// Give a student a clean retake:
await api.post(`/quizzes/attempts/${attemptId}/reset`);
```

---

### 8.6 Global error interceptor

```js
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const { status, data } = err.response ?? {};
    if (status === 401) redirect('/login');                    // dead / missing session
    if (status === 429) toast('Too many requests — slow down'); // rate limit (100/15min/IP)
    return Promise.reject(err);
  }
);
```

---

## 9. Error Matrix

| Endpoint | 400 | 401 | 403 | 404 | 409 | 429 | 500 |
|---|---|---|---|---|---|---|---|
| `GET /videos/:videoId/meta` | Invalid video ID | token | not enrolled | Video not found | — | rate limit | — |
| `POST /videos/:videoId/start` | Invalid video ID | token | not enrolled · must complete video | No quiz found for this video | — | rate limit | — |
| `POST /attempts/:id/submit` | Invalid attempt ID · answers must be an object… | token | Forbidden · Submission deadline has passed. Attempt expired. | Attempt not found | Attempt is already `<STATUS>` | rate limit | — |
| `GET /attempts/:id/result` | Invalid attempt ID · Quiz attempt is still in progress | token | Forbidden | Attempt not found | — | rate limit | — |
| `GET /videos/:videoId/attempts` | Invalid video ID | token | — | Quiz not found | — | rate limit | — |
| `POST /videos/:videoId` (admin) | Title is required · Invalid surveyJson definition + details · answerKey object is required · Invalid answerKey + details · Invalid video ID | token | non-admin | Video not found | — | rate limit | — |
| `DELETE /:quizId` (admin) | Invalid quiz ID | token | non-admin | Quiz not found | — | rate limit | — |
| `GET /:quizId/attempts` (admin) | Invalid quiz ID | token | non-admin | — (empty array) | — | rate limit | — |
| `PUT /attempts/:id/grade` (admin) | Invalid attempt ID · essayScores object is required | token | non-admin | Attempt not found | Attempt status is "X", expected GRADING | rate limit | — |
| `POST /attempts/:id/reset` (admin) | Invalid attempt ID | token | non-admin | Attempt not found | — | rate limit | — |
| `POST /videos/:videoId/exemptions` (admin) | videoId and userId are required | token | non-admin | — | — | rate limit | — |
| `DELETE /exemptions/:exemptionId` (admin) | Invalid exemption ID | token | non-admin | — (⚠️ missing id → **500**) | — | rate limit | — |
| `GET /stream/video/:id/url` · `/embed` · `/stream/videos/:id/next` | — | — | gate blocks — `{ message, … }` shape (§7) | Video not found | — | rate limit | — |

> All quiz-domain errors use the `{ success: false, error }` envelope; only the gate `403`s (§7) use `{ message }`.

---

## 10. Checklist & Gotchas

**Setup**
- [ ] `withCredentials: true` (or Bearer header) on **every** request — quiz routes are auth-gated.
- [ ] Your dev origin must be in the CORS whitelist (`localhost:3000`, `127.0.0.1:3000`, `127.0.0.1:3002`, or set `FRONTEND_URL` on the backend).
- [ ] No `/api` prefix — base is the host root (port `3005` by default).

**Student flow**
- [ ] Gate the "بدء الاختبار" button on `meta.unlocked`; refetch `meta` when the video completes.
- [ ] Derive the countdown from **`deadlineAt`**, never from `timeLimitSec` alone — resumes restore the original deadline.
- [ ] Send `autoSubmitted: true` when your timer fired; the server independently enforces the deadline (+10 s grace).
- [ ] Handle submit `403` (expired) and `409` (double submit) by routing to `GET /attempts/:id/result`.
- [ ] `status: 'GRADING'` after submit → show "pending admin review"; the score shown is provisional.
- [ ] `GET /attempts/:id/result` returns `400` while the attempt is still `IN_PROGRESS`.

**Data & security invariants**
- [ ] `answerKey` is **never** sent to students — don't expect it in any student payload.
- [ ] Correct/model answers appear **only** via the result endpoint after submission.
- [ ] `surveyJson` is capped at 256 KB, types whitelisted (`radiogroup`, `comment`, `html`, `image`), names unique — validate client-side too for nicer UX.
- [ ] `passingScore` defaults to 50 and `0` is coerced to 50 — always send ≥ 1.

**Admin flow**
- [ ] Upsert replaces the whole definition — always POST the complete `surveyJson` + `answerKey` (there is no partial update).
- [ ] ⚠️ Editing the `answerKey` after attempts exist can desync already-recorded scores; prefer reset/delete + recreate for radical changes.
- [ ] Grading queue = `GET /:quizId/attempts?status=GRADING`; fetch each attempt's `result` for model answers; grades are clamped `0…points` server-side.
- [ ] Exemptions are keyed by the **blocking video's id** (the previous video in sequence), not the video the student wants to open.
- [ ] Resetting a passing attempt re-locks the gate.

**Transport**
- [ ] Global rate limit is **100 requests / 15 min / IP** — no aggressive polling.
- [ ] Gate `403`s use `{ message, quizId, yourScore, requiredScore, … }` — key off `quizId` to trigger the quiz UI.
- [ ] `SUBMITTED` status is reserved/unused; treat `GRADING` as "awaiting admin".

---

## Appendix A — Server Constants

| Constant | Value | Source | Meaning |
|---|---|---|---|
| `GRACE_SEC` | `10` s | `src/config/quizConfig.js` | grace added to `deadlineAt` before a late submit is rejected |
| `MAX_SURVEY_JSON_BYTES` | `262144` (256 KB) | `src/config/quizConfig.js` | serialized `surveyJson` cap |
| `ALLOWED_QUESTION_TYPES` | `radiogroup`, `comment`, `html`, `image` | `src/config/quizConfig.js` | SurveyJS type whitelist |
| default `passingScore` | `50` | `prisma/schema.prisma` / controller | percent required to pass |
| default server port | `3005` | `app.js` | `process.env.PORT` override |
| global rate limit | 100 req / 15 min / IP | `app.js` | `429` when exceeded |
| CORS origins | `localhost:3000`, `127.0.0.1:3000`, `127.0.0.1:3002`, `FRONTEND_URL` | `app.js` | `credentials: true` |

---

## Appendix B — TypeScript Types

Drop-in types for the payloads documented above.

```ts
type AttemptStatus = 'IN_PROGRESS' | 'SUBMITTED' | 'GRADING' | 'GRADED' | 'EXPIRED';

// ── GET /quizzes/videos/:videoId/meta ─────────────────────────────
interface QuizMetaNoQuiz { exists: false; videoId: number; videoTitle: string; }
interface InProgressAttemptInfo { id: number; attemptNumber: number; deadlineAt: string | null; }
interface QuizMeta {
  exists: true;
  quizId: number; videoId: number; videoTitle: string; title: string;
  timeLimitSec: number | null; passingScore: number;
  unlocked: boolean; attempted: boolean; totalAttempts: number;
  passed: boolean; bestScore: number | null;
  inProgressAttempt: InProgressAttemptInfo | null;
}

// ── POST /quizzes/videos/:videoId/start ───────────────────────────
interface StudentSafeQuiz {
  id: number; videoId: number; title: string;
  timeLimitSec: number | null; passingScore: number;
  surveyJson: Record<string, unknown>; // answerKey is NEVER included
}
interface StartData {
  attemptId: number; attemptNumber: number; status: AttemptStatus;
  startedAt: string; deadlineAt: string | null;
  resumed: boolean; quiz: StudentSafeQuiz;
}

// ── POST /quizzes/attempts/:id/submit ─────────────────────────────
interface SubmitBody {
  answers: Record<string, unknown>; // { [questionName]: value }
  autoSubmitted?: boolean;
}
interface McqPerQuestion { qName: string; isCorrect: boolean; earned: number; max: number; }
interface SubmitData {
  attemptId: number; status: 'GRADED' | 'GRADING';
  earnedPoints: number; totalPoints: number; scorePercent: number;
  hasEssays: boolean; perQuestion: McqPerQuestion[];
}

// ── GET /quizzes/attempts/:id/result ──────────────────────────────
interface McqResultQuestion {
  name: string; type: 'radiogroup';
  studentAnswer: string | null; correctAnswer: string;
  isCorrect: boolean; earnedPoints: number; maxPoints: number;
}
interface EssayResultQuestion {
  name: string; type: 'comment';
  studentAnswer: string | null; modelAnswer: string;
  earnedPoints: number | null; // null while PENDING_REVIEW
  maxPoints: number; feedback: string | null;
  status: 'GRADED' | 'PENDING_REVIEW';
}
interface QuizResultData {
  attemptId: number; attemptNumber: number; status: AttemptStatus;
  startedAt: string; submittedAt: string | null; autoSubmitted: boolean;
  earnedPoints: number | null; totalPoints: number | null; scorePercent: number | null;
  passed: boolean; passingScore: number;
  questions: (McqResultQuestion | EssayResultQuestion)[];
}

// ── GET /quizzes/videos/:videoId/attempts ─────────────────────────
interface AttemptSummary {
  id: number; attemptNumber: number; status: AttemptStatus;
  startedAt: string; submittedAt: string | null;
  scorePercent: number | null; earnedPoints: number | null;
  totalPoints: number | null; autoSubmitted: boolean;
}
interface StudentAttemptsData {
  quizId: number; title: string; passingScore: number; attempts: AttemptSummary[];
}

// ── Admin: upsert body ────────────────────────────────────────────
interface AnswerKeyEntry {
  type: 'radiogroup' | 'comment';
  correctValue?: string | null; // required for radiogroup
  modelAnswer?: string | null;  // required for comment
  points: number;               // > 0
}
interface UpsertQuizBody {
  title: string;
  timeLimitSec?: number | null;
  passingScore?: number;
  surveyJson: Record<string, unknown>;
  answerKey: Record<string, AnswerKeyEntry>;
}

// ── Sequential-gate 403 bodies (message-based!) ───────────────────
interface QuizGate403 {
  message: string;
  previousVideoId?: number; // stream url/embed endpoints
  currentVideoId?: number;  // next-video endpoint
  quizId?: number;
  yourScore?: number | null;
  requiredScore?: number;
}

// ── Envelopes ─────────────────────────────────────────────────────
interface ApiSuccess<T> { success: true; message?: string; data: T; }
interface ApiError { success: false; error: string; details?: string[]; }
```

---

*Generated from the backend source on branch `Dev` (commit `fe2d2c7`). If the API changes, update this doc — it is the frontend contract.*










