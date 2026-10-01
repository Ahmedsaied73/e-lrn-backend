# E-Learning Platform — API Documentation

Single reference for every HTTP endpoint of the e-learning platform backend. Covers **all** features: auth, users, courses, enrollments, payments, video progress, assignments, SurveyJS quizzes, Bunny.net videos, notifications, search, and the admin console.

**Base URL**: `http://localhost:3005`

> This document is the **single source of truth** for the API. Older per-domain guides (Bunny, quiz, cookie auth, frontend integration) live in [`docs/`](./docs/), kept as design/implementation history. If a guide contradicts this file, this file wins.

---

## Table of Contents

- [1. Global Conventions](#1-global-conventions)
- [2. Authentication & Cookies](#2-authentication--cookies)
- [3. Auth (`/auth`)](#3-auth-auth)
- [4. Users (`/user`)](#4-users-user)
- [5. Courses (`/courses`)](#5-courses-courses)
- [6. Enrollments (`/enroll`, `/admin/enrollments`)](#6-enrollments-enroll-adminenrollments)
- [7. Payments (`/payments`) — disabled](#7-payments-payments--disabled)
- [8. Video Progress (`/progress`)](#8-video-progress-progress)
- [9. Assignments (`/assignments`)](#9-assignments-assignments)
- [10. Quizzes (`/quizzes`)](#10-quizzes-quizzes)
- [11. Bunny Videos (`/courses`, `/videos`)](#11-bunny-videos-courses-videos)
- [12. Bunny Webhook (`/webhooks/bunny/stream`)](#12-bunny-webhook-webhooksbunnystream)
- [13. Notifications (`/notifications`)](#13-notifications-notifications)
- [14. Search (`/search`)](#14-search-search)
- [15. Admin (`/admin`)](#15-admin-admin)
- [16. Health Probes (`/healthz`, `/readyz`, `/health`, `/metrics`)](#16-health-probes-healthz-readyz-health-metrics)
- [17. Sequential Access Gate](#17-sequential-access-gate)
- [18. Error Codes](#18-error-codes)
- [19. AI Admin Agent (`/admin/agent`, `/agent-ws`)](#19-ai-admin-agent-adminagent-agent-ws)

---

## 1. Global Conventions

### Authentication

- Middleware: `authenticateToken` (in `src/middlewares/index.js`). Reads the token from, in order:
  1. `accessToken` cookie (HttpOnly)
  2. `token` cookie (legacy)
  3. `Authorization: Bearer <jwt>` header (compat shim only — never populated by the frontend)
- The JWT must carry `{ type: 'access' }`. Any token without that claim is rejected → **401**.
- Common auth failures → `401 { success: false, error: 'Access denied. No token provided.' | 'Invalid or expired token.' }`
- Admin-only routes use `authorizeAdmin()` (claim check + DB role re-verification with a 5-minute in-proc cache) → `403 { success: false, error: 'Access denied. Insufficient privileges.' }`

### Response envelopes

- **Modern endpoints** return `{ success: true, data: ... }` (and `{ success: false, error, code }` on failure).
- **Legacy endpoints** (payments, search, assignments, video progress *success bodies*) return raw objects and do **not** wrap successes in `success`. Their errors still carry structured `code` values.
- Errors thrown through the global handler (`app.js`) always produce `{ success: false, error: <string>, code: <string> }`.

### Resource identifiers (slug scheme)

Users, courses, Bunny videos and quizzes carry a unique, externally visible `slug`:

| Resource | Slug pattern | Exposed in public payloads | Numeric id |
|---|---|---|---|
| `User` | `[0-9a-z]{12}` (random, opaque) | `{ id, slug, name, ... }` — **both** kept (id needed by deferred admin surfaces) | kept |
| `Course` | `[0-9a-z]{12}` (random, opaque) | `{ slug, ... }` — `id`/`teacherId` **removed** | internal only |
| `BunnyVideo` | `[0-9a-z]{12}` (random, opaque) | `{ slug, courseSlug, quizSlug | null, ... }` — `id`, `courseId`, `bunnyVideoId` **removed** | internal only |
| `Quiz` | `[0-9a-z]{12}` (random, opaque) | `{ slug, videoSlug, ... }` — `id`, `bunnyVideoId` **removed** | internal only |

- All slugs are **opaque random tokens** (`0-9a-z`, exactly 12 chars, ~62 bits) generated server-side — none can be enumerated or guessed from a URL. The same shape is shared by all four resources so a token leaks nothing about its type.
- Route params are slugs everywhere for these resources, e.g. `GET /courses/:slug`, `POST /progress/complete { videoSlug }`. **No redirect shim** — old numeric or readable-slug URLs now `400` (malformed) or `404` (well-formed but missing).
- Deferred surfaces still numeric by design: quiz **attempt** params (`/quizzes/attempts/:id/*`, result/grade/save/submit/reset), exemption params (`/quizzes/exemptions/:exemptionId`), `QuizAttempt`/`Enrollment`/`Submission`/`GateExemption` row ids in admin lists, and legacy `Video` rows.
- Databases, caches (`Redis`), BullMQ, audit `targetId` and notification `metadata` keep numeric ids internally.

### Request size

- Body limit: `express.json({ limit: '512kb' })` → **413** for larger JSON bodies.
- Quiz responses/images/upload bodies have their own limits (documented per endpoint).

### Origin & CSRF guards (all routes)

- **Origin allowlist**: any request with an `Origin` header not in the allowlist (localhost `3000`/`127.0.0.1:3000`/`127.0.0.1:3002`, `FRONTEND_URL` comma-list, `*.vercel.app`) → **403** `{ success: false, error: 'Forbidden.', code: 'ORIGIN_NOT_ALLOWED' }`.
- **CSRF guard**: on `POST`/`PUT`/`PATCH`/`DELETE`, an `Origin` (or `Referer` fallback) not allowlisted → **403** `code: 'CSRF_DENIED_ORIGIN'`. Requests with **no** `Origin`/`Referer` (curl, server-to-server, webhooks) pass through.

### Rate limiting (express-rate-limit, keyed by IP → **429**)

| Scope | Limit |
|---|---|
| Global | 1000 req / 15 min (health probes and the Bunny webhook excluded) |
| `POST /auth/login` | 20 / 15 min |
| `POST /auth/register` | 20 / 15 min |
| `POST /auth/refresh-token` | 60 / 15 min |
| `POST /webhooks/bunny/stream` | 600 / 5 min |

When `REQUIRE_REDIS_RATE_LIMIT=true` and the Redis store is down → **503** `{ success: false, error: 'Rate limiting is temporarily unavailable...', code: 'RATE_LIMIT_STORE_UNAVAILABLE' }`. Default (`false`) falls back to a per-instance in-memory counter.

### Standard status codes

`200` OK · `201` Created · `400` Validation · `401` Unauthenticated · `403` Forbidden / gate block · `404` Not found · `409` Conflict · `413` Too large · `415` Unsupported type · `422` Wrong state · `423` Locked · `429` Rate limited · `500` Internal · `502` Upstream (Bunny) · `503` Unavailable

---

## 2. Authentication & Cookies

Token-based auth with **HttpOnly cookies only**. Tokens never appear in request/response bodies.

| Cookie | Lifetime | Path | Purpose |
|---|---|---|---|
| `accessToken` | 15 min | `/` | Bearer for all API calls |
| `refreshToken` | 7 days | `/auth` | Exchanged for a new access token |

- **Refresh-token rotation**: each `/auth/refresh-token` call issues a new refresh token, persists it to the DB, and re-sets the cookie. The old token is invalidated immediately. Reuse of a rotated (dead) token revokes the whole `refreshTokenFamily`.
- `refreshToken` carries a `jti` nonce so rotation can never produce a byte-identical token.
- `SameSite=lax` in dev; `SameSite=None; Secure` in production.
- The frontend determines login state from a successful `GET /user/me`, not from a body token.
- **Session-preserving register**: `POST /auth/register` runs `optionalAuth` and only sets login cookies when the caller has no session. Registering while logged in (e.g. admin add-student) does not overwrite the caller's session.

---

## 3. Auth (`/auth`)

### `POST /auth/login`
Public. Rate limit 20/15min.
- **Body**: `email` (string), `password` (string)
- **200** `{ success, data: { user: { id, slug, email, name, role } } }` + sets `accessToken` + `refreshToken` cookies
- **400** missing fields · **401** `Invalid credentials.` · **423** `{ success:false, error, code:'ACCOUNT_LOCKED' }` + `Retry-After` (5 consecutive failures within 15 min, Redis `v1:authlock:{email}`; success clears; fail-open when Redis is down)

### `POST /auth/register`
Public (session-preserving, see §2). Rate limit 20/15min.
- **Body**: `email`, `password` (≥8), `name`, `phoneNumber`, `grade` (`FIRST_SECONDARY` | `SECOND_SECONDARY` | `THIRD_SECONDARY`)
- **201** `{ success, message, data: { user: { id, slug, email, name, phoneNumber, grade, role } } }` + login cookies only for unauthenticated callers
- **400** per-field validation · **409** `An account with these details already exists.` (duplicate email **or** phone)

### `POST /auth/logout`
Public. Reads `refreshToken` cookie to null out the DB row.
- **200** `{ success, message: 'Logged out successfully.' }` + clears both cookies

### `POST /auth/refresh-token`
Public. Rate limit 60/15min. **Cookie-only** — `req.body.refreshToken` is never accepted.
- **200** `{ success, message: 'Token refreshed successfully.' }` + new `accessToken` + rotated `refreshToken` cookies
- **401** `Refresh token not provided.` (no cookie) / `Invalid refresh token.` · **403** `Invalid or revoked refresh token.` (access-type token, unknown hash, or reuse detection)

---

## 4. Users (`/user`)

### `GET /user/me`
Any authenticated user.
- **200** `{ success, data: { id, slug, name, email, phoneNumber, grade, role, lastLoginAt, createdAt, features: { notifications, aiGrader } } }`
- **404** `User not found.`

### `GET /user/me/achievements`
Any authenticated user.
- **200** `{ success, data: { totals: { coursesEnrolled, coursesCompleted, videosWatched, videosTotal, examsTaken, examsPassed, averageScore }, courses: [{ course: { id, title, description, thumbnail, grade }, progress: { watched, total, percent, completed }, exams: [{ videoId, videoTitle, quizId, quizTitle, passingScore, timeLimitSec, maxAttempts, bestScore, passed, attemptsUsed }] }] } }`

### `GET /user/` (list) — ADMIN
- **Query**: `page` (≥1), `limit` (1..100, default 20), `role` (`STUDENT`|`ADMIN`), `grade`, `search` (name/email, case-insensitive), `sort` (`name`|`createdAt`, optional leading `-`)
- **200** `{ success, data: [{ id, slug, name, email, phoneNumber, grade, role, lastLoginAt, createdAt }], meta: { total, page, limit, totalPages } }`

### `GET /user/:userSlug` — ADMIN
- **200** `{ success, data: { id, slug, name, email, phoneNumber, grade, role, lastLoginAt, createdAt } }`
- **400** `Invalid user slug.` (not `[0-9a-z]{12}`) · **404** `User not found.`

### `PUT /user/:userSlug`
Authenticated (self **or** ADMIN).
- **Body** (all optional): `name`, `email`, `password` (≥8), `currentPassword` (required for self password/email change), `grade` (**admin-only**), `phoneNumber` (**admin-only**)
- **200** `{ success, message, data: { id, slug, name, email, phoneNumber, grade, role, lastLoginAt, createdAt } }`
- **401** `Current password is required to change password or email.` / `Current password is incorrect.` · **403** `You do not have permission to update this user's data.` · **404** · **409** `Email or phone number already in use.`

### `DELETE /user/:userSlug` — ADMIN
- **200** `{ success, message: 'User deleted successfully.' }`
- **400** `Invalid user slug.` / `Cannot delete your own admin account.` · **404** `User not found.` · **409** `User owns courses. Move or delete their courses before deleting the user.`

---

## 5. Courses (`/courses`)

### `GET /courses/` — authenticated
- **Query**: `page`, `limit` (1..100, default 20), `search` (title)
- **200** `{ success, data: [{ slug, title, description, price, grade, category, thumbnail, teacher: { id, name, email }, videos: [{ id, title, duration }], _count: { videos, enrollments } }], meta: { total, page, limit, totalPages } }` (90s cache) — `id`/`teacherId` not exposed.

### `GET /courses/enrolled` — authenticated
- **200** `{ success, data: [{ id, createdAt, course: <full course row shaped like `GET /courses/:slug` course, absolute thumbnail> }] }`

### `GET /courses/:slug` — authenticated
- **200** `{ success, data: { course: { slug, title, description, price, grade, category, thumbnail, teacher: { id, name, email }, createdAt, updatedAt }, videos: [{ slug, courseSlug, title, thumbnail, duration, position }], enrollment: <Enrollment row sans `userId`/`courseId`, or null>, progress: [{ videoSlug, completed, watchedAt }] } }` (60s per-user cache)
- **400** `Invalid course slug` · **404** `Course not found`

### `POST /courses/` — ADMIN
- **Body**: `title`*, `description`*, `price`*, `grade`* (enum), `category?`, `thumbnail?`
- **201** `{ success, message: 'Course created successfully', data: course }` (public shape — slug assigned automatically; attributes to `req.user.id`; falls back to first ADMIN for script invocation)
- **400** `Title, description, price, and grade are required` / `Invalid price value` / `Invalid grade value`

### `PUT /courses/:slug` — ADMIN
- **Body**: any subset of `title`, `description`, `price`, `grade`, `category`, `thumbnail`
- **200** `{ success, message: 'Course updated successfully', data: course }` (public shape)
- **400** / **404** `Course not found`

### `DELETE /courses/:slug` — ADMIN
- Cascades videos/enrollments/certificates, disconnects learning paths, best-effort **remote Bunny video + Supabase image cleanup**, invalidates gate caches.
- **200** `{ success, message: 'Course deleted successfully' }` · **400** invalid slug · **404**
### `PUT /courses/:courseSlug/reorder` — ADMIN

Reorder Bunny videos in the course. See §11.

---

## 6. Enrollments (`/enroll`, `/admin/enrollments`)

Payment is disabled — every enrollment is auto-paid (`isPaid: true`).

### `POST /enroll/` — authenticated
- **Body**: `courseSlug` (string)
- **201** `{ success, message: 'Enrollment successful!', data: { enrollment: { id, isPaid: true, paymentDate, startedAt, lastAccess, createdAt } } }` (`userId`/`courseId` not exposed)
- **200** existing unpaid row upgraded to active · **409** `Already enrolled in this course.` (pre-check + P2002 race backstop) · **404** `Course not found.`

### `POST /enroll/status` — authenticated
- **Body**: `courseSlug`
- **200** `{ success, data: { enrolled: boolean, enrollment: <row or null> } }`

### `POST /admin/enrollments` — ADMIN
- **Body**: `userSlug`, `courseSlug`
- **201** `{ success, message: 'Student enrolled successfully.', data: { enrollment } }` (auto-paid)
- **400** `userSlug and courseSlug are required.` · **404** `User not found.` / `Course not found.` · **409** `Student is already enrolled in this course.`

### `DELETE /admin/enrollments/:id` — ADMIN
- **200** `{ success, message: 'Enrollment removed successfully.' }` (FK-safe; invalidates gate + course caches) · **400** · **404**

### `GET /admin/enrollments` — ADMIN
- **Query**: `page`, `limit` (1..100, default 20), `userSlug`, `courseSlug`, `isPaid`, `isCompleted`, `search` (student name/email or course title)
- **200** `{ success, data: [{ id, student: { id, slug, name, email, grade }, course: { slug, title, grade }, isPaid, paymentDate, progress, isCompleted, completedAt, startedAt, lastAccess, createdAt }], meta: { total, page, limit, totalPages } }`

---

## 7. Payments (`/payments`) — disabled

Legacy raw envelope. **Disabled in production.**

### `POST /payments/course/:courseId` — authenticated
- **Production**: **403** `{ success: false, error: 'Payment processing is not available. Please contact support.' }`
- **Otherwise**: **200** raw `{ message: 'Payment processed successfully', payment, enrollment }` or `{ message: 'Course was already paid for', enrollment }`
- **400** / **404** / **500** raw `{ error }`

### `GET /payments/history` — authenticated
- **200** raw `{ payments: [...], paidCourses: [{ ...enrollment, course: { id, title, thumbnail, price } }] }`

---

## 8. Video Progress (`/progress`)

Operates on **`BunnyVideo`** slugs (the modern video system). Success bodies use the legacy raw shape; errors carry structured codes.

### `POST /progress/complete` — authenticated
- **Body**: `videoSlug` (BunnyVideo slug)
- **200** raw `{ message: 'Video marked as completed', videoSlug, videoProgress: { completed: true, watchedAt } }` (numeric `userId`/`bunnyVideoId` not exposed) — upserts progress, syncs `Enrollment.progress` %/`isCompleted`, invalidates course/gate/meta caches
- **Gate**: video must be the current unlocked index (first in course, or previous completed + quiz passed + assignment submitted). See §17.
- **400** `Invalid video slug` · **403** `{ error, code: 'NOT_ENROLLED' }` / `{ error, code: 'VIDEO_NOT_UNLOCKED', previousVideoSlug }` / `{ error, code: 'SEQUENTIAL_GATE', ... }` · **404** `{ error, code: 'VIDEO_NOT_FOUND' }`

### `GET /progress/course/:courseSlug` — authenticated
- **200** raw `{ courseSlug, totalVideos, completedVideos, videos: [{ videoSlug, title, duration, completed, watchedAt }] }` (enrollment-gated for students)
- **403** `{ error, code: 'NOT_ENROLLED' }` for non-enrolled students

### `GET /progress/:videoSlug` — authenticated
- **200** raw `{ videoSlug, completed: boolean, watchedAt: <date|null> }`
- **403** `{ error, code: 'NOT_ENROLLED' }` when not enrolled

---

## 9. Assignments (`/assignments`)

Legacy raw envelope on successes. Assignment gate fields are stripped for students who have not submitted (answer-key protection).

### `POST /assignments/` — ADMIN
- **Body**: `title`*, `videoId`* (legacy `Video` id), `description?`, `dueDate?` (date string), `isMCQ?` (bool), `passingScore?` (MCQ), `questions?` (MCQ: `[{ text, options, correctOption, explanation, points }]`)
- **201** MCQ: `{ message: 'MCQ assignment created successfully', assignment }`; text: `{ message: 'Assignment created successfully', assignment }`
- **400** / **404** `Video not found`

### `POST /assignments/submit` — authenticated
- **Body**: `assignmentId`*, and either `content` (text), `fileUrl` (http(s), ≤2048 chars), or `answers` (MCQ: `[{ questionId, selectedOption }]`)
- **200** MCQ: `{ message: 'MCQ assignment passed|failed', submission, mcqScore, passed, passingScore }` (auto-graded → `GRADED`); text: `{ message: 'Assignment submitted successfully', submission }` (→ `PENDING`)
- **400** due-date passed / already graded → not resubmittable · **403** `You must be enrolled in this course to submit assignments` · **404**

### `POST /assignments/submissions/:submissionId/grade` — ADMIN
- **Body**: `grade`* (0–100), `feedback?`, `status?` (default `GRADED`)
- **200** `{ message: 'Submission graded successfully', submission }`

### `GET /assignments/user/submissions` — authenticated
- **200** `{ submissionsCount, submissions: [{ ...submission, assignment: { ... , video: { id, title, courseId } } }] }`

### `GET /assignments/video/:videoId` — authenticated (legacy videos only)
- **200** `{ assignments: [{ ...assignment, hasSubmitted, submission: { id, status, grade, submittedAt } | null }] }` · **403** plain enrollment message

### `GET /assignments/course/:courseId` — authenticated
- **200** `{ course: { id, title }, assignments: [{ ...assignment, video: { id, title } }] }`

### `GET /assignments/:assignmentId/submissions` — ADMIN
- **200** `{ assignmentId, title, submissionsCount, submissions: [{ ...submission, user: { id, name, email } }] }`

### `GET /assignments/:assignmentId/status` — authenticated
- **200** not-submitted: `{ assignmentId, title, submitted: false, status: 'NOT_SUBMITTED', message, dueDate, isPastDue }`
- **200** submitted: `{ assignmentId, title, submitted: true, submittedAt, status, grade, feedback, isMCQ, mcq: { score, passingScore, passed } | null, gradedAt, dueDate, isPastDue }`

### `GET /assignments/:id` — authenticated
- **200** raw `{ ...assignment, hasSubmitted, submission }`. **`correctOption`/`explanation` are stripped** for students who have not submitted (ADMIN and post-submit see full). MCQs include per-question `userAnswer: { selectedOption, isCorrect }`.

---

## 10. Quizzes (`/quizzes`)

SurveyJS lifecycle, modern `{ success, data }` envelope. `maxAttempts` default **3** (validated 1–10). Attempt statuses: `IN_PROGRESS | SUBMITTED | GRADING | GRADED | EXPIRED`. **EXPIRED attempts never consume a retake.**

### `GET /quizzes/videos/:videoSlug/meta` — authenticated
- **200 (no quiz)** `{ success, data: { exists: false, videoSlug, videoTitle } }`
- **200 (quiz)** `{ success, data: { exists: true, quizSlug, videoSlug, videoTitle, title, timeLimitSec, passingScore, maxAttempts, attemptsUsed, atMaxAttempts, unlocked, attempted, totalAttempts, passed, bestScore, totalQuestions, totalPoints, inProgressAttempt: { id, attemptNumber, deadlineAt } | null } }` (30s per-user cache; numeric `quizId`/`videoId` not exposed)
- **403** `You are not enrolled in this course` · **404** `Video not found`

### `POST /quizzes/videos/:videoSlug/start` — authenticated
- **200** `{ success, data: { attemptId, attemptNumber, status: 'IN_PROGRESS', startedAt, deadlineAt, resumed: boolean, responses: <saved or null>, quiz: { slug, videoSlug, title, timeLimitSec, passingScore, maxAttempts, surveyJson } } }` — `answerKey` stripped. Resumes `IN_PROGRESS`, expires past-deadline attempts (+10s grace), auto-submits stale untimed attempts (>30 min).
- **409** `{ ..., code: 'ALREADY_PASSED' }` / `{ ..., code: 'MAX_ATTEMPTS_REACHED' }` · **403** not enrolled / `You must complete the video before taking the quiz` · **404** `No quiz found for this video`

### `PATCH /quizzes/attempts/:id/save` — authenticated
- **Body**: `responses` (object map, ≤256KB serialized)
- **200** `{ success, data: { attemptId, saved: true } }`
- **409** `Attempt is already <status>` (not re-saveable after submit)

### `POST /quizzes/attempts/:id/submit` — authenticated
- **Body**: `answers` (object map), `autoSubmitted?` (bool)
- **200** `{ success, data: { attemptId, status: 'GRADED' | 'GRADING', earnedPoints, totalPoints, scorePercent, hasEssays, perQuestion: [{ qName, isCorrect, earned, max }] } }` — MCQs auto-graded at submit; essays → `GRADING` (+ AI-grader enqueue if enabled, notification via `notifyGradedSafe`).
- **403** `Submission deadline has passed. Attempt expired.` · **409** already-submitted

### `GET /quizzes/attempts/:id/result` — owner or ADMIN
- **200** `{ success, data: { attemptId, attemptNumber, status, startedAt, submittedAt, autoSubmitted, earnedPoints, totalPoints, scorePercent, passed, passingScore, questions: [{ name, type: 'radiogroup'|'comment', studentAnswer, correctAnswer | null, isCorrect, earnedPoints, maxPoints, feedback, status: 'GRADED'|'PENDING_REVIEW', gradedBy, confidence, gradedModel }] } }` — **model answers hidden until the attempt is GRADED and passed** (ADMIN always sees them).
- **400** `Quiz attempt is still in progress` · **403** `Forbidden`

### `GET /quizzes/videos/:videoSlug/attempts` — authenticated
- **200** `{ success, data: { quizSlug, videoSlug, title, passingScore, attempts: [{ id, attemptNumber, status, startedAt, submittedAt, scorePercent, earnedPoints, totalPoints, autoSubmitted }] } }`

### `POST /quizzes/videos/:videoSlug` — ADMIN (upsert by `bunnyVideo` slug)
- **Body**: `title`*, `surveyJson`* (≤256KB; `pages[].elements`, types `radiogroup|comment|html|image`, unique names), `answerKey`* (`{ qName: { type, correctValue?, modelAnswer?, points, rubric?, ai: { enabled? } } }`), `timeLimitSec?`, `passingScore?` (0–100, default 50), `maxAttempts?` (1–10, default 3)
- **200** `{ success, message: 'Quiz saved successfully', data: quiz }` (sanitized — no `answerKey`, no numeric ids)
- **400** `Invalid surveyJson definition` / `Invalid answerKey` etc. · **404** `Video not found`

### `POST /quizzes/images` — ADMIN
- **Body**: `multipart/form-data` field `image` (JPEG/PNG/WebP/GIF, ≤5MB) via busboy (no body-parser).
- **201** `{ success, data: { url: <public storage URL> } }`
- **413** `Image too large (max 5MB)` · **415** unsupported type · **501** `Image upload is not configured` (missing Supabase, dev only) · **502** `Image upload failed`

### `DELETE /quizzes/:quizSlug` — ADMIN
- Cascades attempts, best-effort storage cleanup. **200** `{ success, message: 'Quiz deleted successfully' }` · **400** invalid slug · **404**

### `GET /quizzes/:quizSlug/attempts` — ADMIN
- **Query**: `status?` (`IN_PROGRESS|SUBMITTED|GRADING|GRADED|EXPIRED`)
- **200** `{ success, data: [{ id, quizId, userId, attemptNumber, status, startedAt, deadlineAt, submittedAt, autoSubmitted, mcqEarned, essayEarned, earnedPoints, totalPoints, scorePercent, essayFeedback, essayGradedBy, essayGradedAt, user: { id, name, email } }] }` — no per-question responses leaked.

### `PUT /quizzes/attempts/:id/grade` — ADMIN
- **Body**: `essayScores`* (`{ qName: number 0..max }`), `essayFeedback?` (`{ qName: string }`) — must score **every** essay.
- **200** `{ success, message: 'Attempt graded successfully', data: updatedAttempt }` (finalizes `GRADED`, clamps to max points)
- **409** `Attempt status is "<status>", expected GRADING` / `Missing scores for essay questions: ...` · **422** non-numeric score

### `POST /quizzes/attempts/:id/reset` — ADMIN
- Deletes the attempt row, invalidates meta + gate caches. **200** `{ success, message: 'Attempt reset successfully' }`.

### `POST /quizzes/videos/:videoSlug/exemptions` — ADMIN
- **Body**: `userSlug`*, `reason?`
- **200** `{ success, message: 'Gate exemption granted successfully', data: gateExemption }` (upsert by `userSlug` + `bunnyVideo` slug) · **404** video/user not found

### `DELETE /quizzes/exemptions/:exemptionId` — ADMIN
- **200** `{ success, message: 'Exemption revoked successfully' }` · **404** `Exemption not found`

---

## 11. Bunny Videos (`/courses`, `/videos`)

Modern video system on Bunny.net Stream, `{ success, data }` envelope with AppError codes. **State machine**: `PENDING → UPLOADING → PROCESSING → READY | FAILED`. Re-upload only from `PENDING|FAILED`.

### `POST /courses/:courseSlug/videos` — ADMIN
- **Body**: `title`*
- **201** `{ success, data: { slug, courseSlug, title, status: 'PENDING', quizSlug: null, createdAt } }`
- **400** `{ error, code: 'COURSE_NOT_FOUND' }` / `{ error, code: 'VALIDATION_ERROR' }` · **502** `{ error, code: 'BUNNY_API_ERROR' }`

### `GET /courses/:courseSlug/bunny-videos` — authenticated
- **ADMIN** sees all statuses + `failureReason` + `processingProgress`; **students see only `READY`** videos.
- **200** `{ success, data: [{ slug, courseSlug, title, position, status, duration, width, height, thumbnailUrl, createdAt, quizSlug | null, failureReason?, processingProgress? }] }` (60s cache) — numeric `id`/`courseId`/`bunnyVideoId` not exposed.

### `PUT /courses/:courseSlug/reorder` — ADMIN
- **Body**: `videoSlugs` (string array — exactly the course's Bunny video slugs, each once)
- **200** `{ success, data: [{ slug, title, position }] }` (1-based positions; enrolled students' gate caches invalidated)
- **400** `{ error, code: 'INVALID_VIDEO_IDS' }` / `{ error, code: 'COURSE_NOT_FOUND' }`

### `POST /videos/:videoSlug/upload` — ADMIN
- **Body**: `multipart/form-data` field `video` (mp4/mov/mkv/avi/webm, default max 5GB via `BUNNY_VIDEO_MAX_BYTES`) via busboy, streamed straight to Bunny (no temp files).
- **200** `{ success, data: { videoSlug, status: 'PROCESSING', message } }`
- **400** `{ code: 'VIDEO_NOT_FOUND' }` / `{ code: 'INVALID_VIDEO_FILE' }` · **413** `{ code: 'VIDEO_TOO_LARGE' }` · **415** `{ code: 'INVALID_VIDEO_FILE' }` · **422** `{ code: 'INVALID_VIDEO_STATE' }` (must be PENDING/FAILED) · **502** `{ code: 'VIDEO_UPLOAD_FAILED' }`

### `GET /videos/:videoSlug/playback` — authenticated (+ sequential gate; ADMIN bypasses)
- **200** `{ success, data: { videoSlug, playbackUrl: <HMAC-signed iframe.mediadelivery.net embed>, expiresAt } }` (6h TTL)
- **403** `{ message, code: 'NOT_ENROLLED' }` / `{ message, code: 'SEQUENTIAL_GATE', previousVideoSlug, quizSlug?, yourScore?, requiredScore? }` · **404** `{ code: 'VIDEO_NOT_FOUND' }` · **422** `{ code: 'VIDEO_NOT_READY' }`

### `DELETE /videos/bunny/:videoSlug` — ADMIN
- Deletes remote Bunny video first (404 remote tolerated), then DB row.
- **200** `{ success, data: { slug, bunnyVideoId, message: 'Video successfully deleted from Bunny Stream and database.' } }` · **404** `{ code: 'VIDEO_NOT_FOUND' }` · **502** `{ code: 'BUNNY_API_ERROR' }`

---

## 12. Bunny Webhook (`/webhooks/bunny/stream`)

**Not part of the browser API** — Bunny.net calls this. Mounted **before** `express.json()` (needs raw body for HMAC). No `Origin` → unaffected by CORS/CSRF guards.

- **Auth**: `X-BunnyStream-Signature`, `X-BunnyStream-Signature-Version: v1`, `X-BunnyStream-Signature-Algorithm: hmac-sha256`
- **Body** (raw JSON, 2MB limit): `{ VideoGuid: string, Status: number }`
- **Status mapping**: 0–2 → `PROCESSING`, 3–4 → `READY`, 5 → `FAILED`, 6–10 → ignored
- **200** empty body (idempotent; unknown video logged and ignored) · **400** empty (malformed JSON / missing VideoGuid / non-numeric Status) · **401** empty (bad signature) · **429** (600/5min)
- On `READY`: `notifyReadySafe` triggers student notifications (feature-gated).

---

## 13. Notifications (`/notifications`)

Optional module — mounted only when `NOTIFICATIONS_ENABLED !== false`. Modern envelope. DB is the source of truth (one row per recipient; no Redis/WS in V1).

### `GET /notifications/` — authenticated
- **Query**: `page`, `limit` (1..100, default 20), `unreadOnly` (`true`/`1`)
- **200** `{ success, data: { items: [{ id, userId, type, title, body, linkUrl, metadata, read, batchId, createdAt }], total, page, limit } }`

### `GET /notifications/unread-count` — authenticated
- **200** `{ success, data: { count } }`

### `PATCH /notifications/read-all` — authenticated
- **200** `{ success, data: { updated } }`

### `PATCH /notifications/:id/read` — authenticated
- Scoped to the caller's own rows. **200** `{ success, data: { updated: 0|1 } }`

### `POST /notifications/broadcast` — ADMIN
- **Body**: `title`* (≤200), `body?` (≤5000), `linkUrl?` (internal path starting with `/`, ≤500), `metadata?` (object), `audience`* — `{ kind: 'all' }`, `{ kind: 'course', courseSlug }`, or `{ kind: 'grade', grade }`
- **201** `{ success, data: { count, batchId } }` (one row per student; chunked fan-out)
- **400** validation (title required/too long, bad linkUrl, invalid audience/course/grade) · **404** `Course not found`

---

## 14. Search (`/search`)

Legacy raw envelope on successes.

### `GET /search/content` — authenticated
- **Query**: at least one of `query`, `category`, `grade` required. Also `type?` (`courses`|`videos`), `minPrice?`, `maxPrice?`, `sortBy?` (`relevance|price_low|price_high|newest|popularity`), `limit?` (1..100, default 20)
- **200** raw `{ query, filters: { category, grade, minPrice, maxPrice, sortBy }, totalResults, availableCategories, availableGrades, courses: [...], videos: [...] }` (60s cache)
- **400** `Either search query, category, or grade filter must be provided` / invalid type/grade/price

### `GET /search/trending` — authenticated
- **Query**: `limit?` (1..100, default 10), `category?`, `grade?`
- **200** raw `{ trending: [{ slug, title, description, price, category, grade, thumbnail, teacher, enrollmentCount, videoCount }] }` (10min cache, by enrollment desc) — `id`/`teacherId` not exposed.

### `GET /search/recommended` — authenticated
- **200** raw `{ recommendations: [{ slug, title, description, price, category, grade, thumbnail, teacher, videoCount }] }` (top 10 by user's enrolled categories/grades, excluding enrolled)

---

## 15. Admin (`/admin`)

Every route behind `authenticateToken` + `authorizeAdmin()` at the router level. Serializers never leak `answerKey`, `answers`, `password`, or `refreshToken`.

### `GET /admin/dashboard` — ADMIN
- **200** `{ success, data: { counts: { students, admins, courses, enrollments, quizzes, newStudentsLast7d, attempts: { status: count }, videos: { total, ...status counts }, submissionsPending }, alerts: { failedVideos, stuckProcessingVideos, essaysPendingGrading, hasIssues }, recent: { users[5], enrollments[5], attempts[5] }, features: { notifications, aiGrader } } }` (30s cache)

### `GET /admin/quizzes` — ADMIN
- **Query**: `page`, `limit` (1..100, default 20), `search?` (quiz/video/course title)
- **200** `{ success, data: [{ slug, title, videoSlug, videoTitle, courseSlug, courseTitle, timeLimitSec, passingScore, maxAttempts, totalAttempts, pendingGrading, updatedAt }], meta: { total, page, limit, totalPages } }`

### `GET /admin/attempts` — ADMIN
- **Query**: `status?`, `page`, `limit`, `search?` (student name/email or quiz title)
- **200** `{ success, data: [{ id, quizId, quizTitle, videoId, videoTitle, courseId, courseTitle, student: { id, name, email, grade }, attemptNumber, status, startedAt, submittedAt, mcqEarned, essayEarned, scorePercent, passingScore, passed, essayGradedAt }], meta }`

### `GET /admin/ai-grading/jobs` — ADMIN (module present only when `AI_GRADER_ENABLED`)
- **Query**: `status?` (`PENDING|DONE|FAILED`, default `FAILED`), `page`, `limit`, `search?`
- **200** `{ success, data: [{ id, attemptId, questionName, status, tries, maxTries, confidence, applied, error, claimedAt, createdAt, updatedAt, attemptStatus, attemptNumber, submittedAt, student, quizId, quizTitle, videoId, videoTitle, courseId, courseTitle }], meta: { total, page, limit, totalPages, status } }`

### `POST /admin/ai-grading/retry` — ADMIN
- **Body**: `attemptIds?` (array of ints; absent = all `FAILED` attempts)
- **200** `{ success, data: { attempts, jobsEnqueued, cleared, perAttempt: [{ attemptId, jobsEnqueued, cleared }] } }`

### (`GET /admin/enrollments`, `POST /admin/enrollments`, `DELETE /admin/enrollments/:id` — see §6)

---

## 16. Health Probes (`/healthz`, `/readyz`, `/health`, `/metrics`)

Mounted **before** the global rate limiter — never throttled, no auth.

### `GET /healthz`
- **200** `{ status: 'ok', uptime: <sec> }` — liveness, zero I/O.

### `GET /readyz`
- **200** `{ status: 'ok', db: 'up', uptime, ms }` · **503** `{ status: 'error', db: 'down', ms }` — DB ping (3s timeout). Redis never gates readiness.

### `GET /health`
- **200** `{ status: 'ok', db: 'up', uptime, ms }` · **503** — legacy DB-ping healthcheck (test harness / CI compatible).

### `GET /metrics`
- **200** Prometheus text format (a scrape target, not an API — no auth, no envelope). Exposes process-lifetime counters: `http_requests_total{status="..."}` and `http_errors_5xx_total`. Counters are **per-instance since process boot** (they reset on restart; a single scrape yields totals, not a rate).
- The `uptime-probe` GitHub Action (`.github/workflows/uptime.yml`) polls `/readyz` every 15 minutes and fails the run (→ notification email to repo watchers) on a non-200 readiness response or when lifetime 5xx errors exceed 5% of total requests. When the metrics-scrape step itself fails, it attaches the raw metrics snapshot as a `metrics-snapshot` artifact for debugging (no artifact on a bare readiness failure, since the scrape never ran). Requires the `PROD_BASE_URL` repo secret (base URL without trailing slash).

---

## 17. Sequential Access Gate

`quizService.evaluateGate()` (in `src/services/quizService.js`) is the **single source of truth**. Redis-cached 5 min per user+video. ADMIN always bypasses.

For a student to access a **non-first** Bunny video in a course, **all** of the following must hold:

1. **Enrollment**: the student is enrolled in the course → else `NOT_ENROLLED`.
2. **Previous video**: the immediately preceding video (by `position`, or in-app ordering) is:
   - A `BunnyVideoProgress` row with `completed: true` → else `SEQUENTIAL_GATE` + `previousVideoSlug`; or
   - Covered by a `GateExemption` (admin-granted).
3. **Previous quiz**: if the previous video has a quiz, at least one attempt is `GRADED` with `scorePercent >= passingScore` (best score counts) → else `SEQUENTIAL_GATE` + `quizSlug`, `bestScore`, `required`.

Gate codes surfaced to clients: `NOT_ENROLLED`, `SEQUENTIAL_GATE`, `VIDEO_NOT_UNLOCKED` (on progress-complete), `VIDEO_NOT_FOUND`. `POST /progress/complete` and `GET /videos/:videoSlug/playback` both enforce it.

**Gate exemptions**: granted per `(userSlug, videoSlug)` via `POST /quizzes/videos/:videoSlug/exemptions` (ADMIN); removed via `DELETE /quizzes/exemptions/:exemptionId`.

---

## 18. Error Codes

Structured `code` values returned by the global handler (in addition to the HTTP status):

| Code | Status | Meaning |
|---|---|---|
| `ACCOUNT_LOCKED` | 423 | Login lockout after N consecutive failures |
| `RATE_LIMIT_STORE_UNAVAILABLE` | 503 | Redis rate-limit store down in fail-closed mode |
| `ORIGIN_NOT_ALLOWED` | 403 | Origin not in allowlist |
| `CSRF_DENIED_ORIGIN` | 403 | CSRF origin/referer check failed |
| `NOT_ENROLLED` | 403 | User not enrolled in the course |
| `SEQUENTIAL_GATE` | 403 | Previous video not completed / quiz not passed |
| `VIDEO_NOT_UNLOCKED` | 403 | Attempted to complete a video not at the current index |
| `VIDEO_NOT_FOUND` | 404 | Bunny/video not found (gate path) |
| `COURSE_NOT_FOUND` | 400/404 | Course lookup failed |
| `VIDEO_NOT_READY` | 422 | Video not yet `READY` for playback |
| `INVALID_VIDEO_STATE` | 422 | Upload on a video not `PENDING`/`FAILED`, etc. |
| `INVALID_VIDEO_IDS` | 400 | Reorder payload not the exact video slug set |
| `INVALID_VIDEO_FILE` | 400/415 | Missing/malformed/mis-typed upload field |
| `VIDEO_TOO_LARGE` | 413 | Upload exceeds `BUNNY_VIDEO_MAX_BYTES` |
| `VIDEO_UPLOAD_FAILED` | 502 | Bunny upload failed |
| `BUNNY_API_ERROR` | 502 | Bunny API call failed |
| `BUNNY_WEBHOOK_INVALID_SIGNATURE` | 401 | Webhook HMAC mismatch |
| `VALIDATION_ERROR` | 400 | Payload validation failed |
| `ALREADY_PASSED` | 409 | Quiz start while a passed attempt exists |
| `MAX_ATTEMPTS_REACHED` | 409 | Quiz attempt budget exhausted |
| `AGENT_QUESTION_REQUIRED` | 400 | Agent turn with a missing/blank `question` (§19) |
| `AGENT_QUESTION_TOO_LONG` | 400 | Agent `question` over 2000 characters (§19) |
| `AGENT_INVALID_INPUT` | 400 | Agent body/param shape invalid (§19) |
| `AGENT_CONVERSATION_NOT_FOUND` | 404 | Agent conversation missing or owned by another admin (§19) |
| `AGENT_APPROVAL_NOT_FOUND` | 404 | Approval missing / not owned by this admin (§19) |
| `AGENT_APPROVAL_NOT_OWNED` | 404 | Approval belongs to another admin (`decide`) (§19) |
| `AGENT_APPROVAL_EXPIRED` | 409 | Approval TTL elapsed (`decide`) (§19) |
| `AGENT_APPROVAL_REJECTED` | 409 | Approval was already rejected (`decide`) (§19) |
| `AGENT_APPROVAL_ALREADY_CONSUMED` | 409 | Approval grant was already spent (`decide`) (§19) |
| `AGENT_APPROVAL_NOT_PENDING` | 409 | Approval row is not `PENDING` anymore (`decide`) (§19) |
| `AGENT_APPROVAL_INVALID_INPUT` | 400 | `POST /admin/agent/approvals` body invalid (tool/args/ttl) (§19) |
| `AGENT_RATE_LIMITED` | 429 | Per-admin minute turn budget exhausted on `POST /ask` (§19) |
| `AGENT_DAILY_BUDGET_EXCEEDED` | 429 | Per-admin **daily** turn budget exhausted on `POST /ask` (§19) |

> Turn-level agent codes (`AGENT_DISABLED`, `EMPTY_QUESTION`, `LLM_*`, `GROUNDING_FAILED`, …) are **not** global-handler codes: they ride a `200` with `ok: false` and are listed in §19.

---

## 19. AI Admin Agent (`/admin/agent`, `/agent-ws`)

Admin copilot: analytics questions answered from the platform database, plus guarded mutations that only run under a single-use human approval. Sources: `src/routes/agentRoutes.js` (REST), `src/services/agent/socketHandler.js` (WebSocket), `src/services/agent/agentService.js` (one turn), `src/config/env.js` → `resolveAiAgent()` (config).

### Conditional mount

- Mounted by `app.js` **only when `AI_AGENT_ENABLED=true`** (default `false`). While it is false there is **no `/admin/agent` router and no `/agent-ws` socket server at all** — disabled means absent, never stubbed (same doctrine as the payments and notifications modules).
- REST: `app.use('/admin/agent', require('./src/routes/agentRoutes'))`, mounted before the global error handler.
- Socket: attached inside the `app.listen()` callback (`initAgentSocket(server)`), not at require time, so importing `app.js` without listening never creates a socket server (or its timers).
- Second, independent switch: `AI_AGENT_ALLOW_MUTATIONS` (default `false`). While false the mutating tools are not registered with the model at all, so no prompt (or prompt injection) can reach them. `allowMutations` can never be `true` while `enabled` is `false`.
- Neither switch is boot-critical: a missing provider key only leaves the module `configured: false`, which answers with an Arabic configuration error instead of crashing boot.

### Authentication

- Every route sits behind `router.use(authenticateToken, authorizeAdmin())` — the same order as every other `/admin/*` router.
- Anonymous / invalid token → **401** `{ success: false, error: 'Access denied. No token provided.' | 'Invalid or expired token.' }`.
- Authenticated non-admin → **403** `{ success: false, error: 'Access denied. Insufficient privileges.' }`.
- The WebSocket has its own equivalent middleware — cookie-only, with a DB admin re-check (see below).

### Turn budget — BOTH `POST /ask` and the WebSocket (Phase 4.5)

One policy, two surfaces: `src/services/agent/limits.js` is the only place that decides
whether a turn may run. Before this the limiter existed on the REST route only, which left
the socket as the cheaper path to an unlimited LLM bill, and `AI_AGENT_DAILY_TURN_BUDGET`
was resolved and clamped but enforced nowhere.

| Setting | Value |
|---|---|
| Minute bucket | `Number(process.env.AI_AGENT_ASK_LIMIT) || 60` per 60 s, key `agent:turns:m:<adminId>:<yyyymmddhhmm>`, TTL 120 s |
| Day bucket | `config.aiAgent.dailyTurnBudget` (default 500), key `agent:turns:d:<adminId>:<yyyymmdd>`, TTL until local midnight |
| Key | **per admin**, never per IP — the same admin behind two networks shares one budget |
| Store | Redis (`INCR` + `EXPIRE` once per key) when `isRedisReady()`, else a bounded in-process counter |
| Refused turn | **counted anyway** — a client that retries a closed budget cannot walk past it |

| Surface | Exceeded | Body |
|---|---|---|
| `POST /ask` | **429** + `Retry-After` | `{ success: false, error, code: 'AGENT_RATE_LIMITED' }` |
| `POST /ask` | **429** + `Retry-After` (until midnight) | `{ …, code: 'AGENT_DAILY_BUDGET_EXCEEDED' }` |
| `agent:message` | `agent:error` | `{ code: 'RATE_LIMITED' \| 'DAILY_BUDGET_EXCEEDED', detail, retryAfterMs }` — the service is **not** called |

- **Fail-open, always.** If Redis is unreachable the counter falls back to a bounded local
  map (the same house rule as `rateLimitStore.js`), and a limiter that *throws* is ignored
  rather than turned into a 503. A provider outage must never become "the admin cannot ask a
  question". The honest cost: during a Redis outage the ceiling is per-process, not shared.
- The socket rejection happens **before** the service call, so a refused turn never reaches
  the model or the database.
- Rationale (from the route header): one call can reach a paid LLM, the same reason the
  Paymob checkout endpoint is per-user limited.

### Endpoints

| Method | Path | Body / query | Success response |
|---|---|---|---|
| `POST` | `/admin/agent/ask` | `{ question, conversationId?, approvalId? }` | **200** `{ success: true, ok: true, answer, source, conversationId, detail }` — or **200** with `ok: false` (turn results below) |
| `GET` | `/admin/agent/conversations` | query `take?` (default 30, clamped 1..50) | **200** `{ success: true, data: [{ id, title, updatedAt, lastMessageAt, messageCount }] }` |
| `GET` | `/admin/agent/conversations/:id/messages` | — | **200** `{ success: true, data: [{ id, role, content, toolName, createdAt }] }` |
| `POST` | `/admin/agent/approvals` | `{ toolName, args, conversationId?, ttlMs? }` | **201** `{ success: true, data: { id, toolName, argsHash, status, expiresAt } }` — ⚠ **currently returns 500, see below** |
| `POST` | `/admin/agent/approvals/:id/decide` | `{ approved: true \| false }` | **200** `{ success: true, data: { id, status, decidedAt, decidedBy } }` |
| `GET` | `/admin/agent/approvals/:id` | — | **200** `{ success: true, data: { id, toolName, argsHash, status, requestedAt, expiresAt, decidedAt, consumedAt, conversationId } }` |

All six answer the repo's error shape `{ success: false, error, code }` when they throw.

### `POST /admin/agent/ask` — ADMIN (turn-budgeted)
- **Body**: `question` (non-empty string, ≤ 2000 chars), `conversationId?` (positive int), `approvalId?` (positive int — spends a previously granted, owner-checked approval exactly once).
- **200** `{ success: true, ok: true, answer, source, conversationId, detail }`. `source` is `'deterministic'` (the Arabic fast path, no LLM) or `'llm'` (the model tier). `detail` = `{ provider, toolCalls, stopReason, approval, approvalRequested, latencyMs }` for a model answer, or `{ intent, tool, latencyMs, declinedReason }` for the fast path (`approvalRequested` is `{ approvalId, toolName, expiresAt }` or `null`).
- **200** `{ success: true, ok: false, code, message, conversationId, declinedReason, ungrounded }` — an expected agent failure, not an HTTP error (codes below).
- **503** the same `ok: false` envelope with `code: 'AGENT_DISABLED'`.
- **400** `AGENT_QUESTION_REQUIRED` (missing/blank `question`), `AGENT_QUESTION_TOO_LONG` (> 2000 chars), `AGENT_INVALID_INPUT` (`conversationId`/`approvalId` not a positive integer).
- **429** + `Retry-After` `AGENT_RATE_LIMITED` / `AGENT_DAILY_BUDGET_EXCEEDED` — see *Turn budget* above.
- **Phase 4.5 — `conversationId` on a failed turn.** A conversation row is now written *together with* its first turn, in one round trip, so a turn that produced no answer cannot leave an empty row behind. Consequence: when a **new** conversation is refused (`LLM_ERROR`, `LLM_UNAVAILABLE`, `GROUNDING_FAILED`, `EMPTY_ANSWER`, `TOOL_BUDGET_EXHAUSTED`, `LLM_NOT_CONFIGURED`), the response carries `conversationId: null` and no conversation exists. When a turn on an **existing** conversation is refused, the id is still returned (that conversation exists) and nothing is written to it. Clients must therefore treat `conversationId: null` as "start a new conversation on the next question", not as an error.

### `GET /admin/agent/conversations` — ADMIN
- **Query**: `take` (default 30, clamped to 1..50; a non-numeric value falls back to the default rather than erroring).
- **200** `{ success: true, data: [{ id, title, updatedAt, lastMessageAt, messageCount }] }` — newest `updatedAt` first, for this admin only.

### `GET /admin/agent/conversations/:id/messages` — ADMIN
- **200** `{ success: true, data: [{ id, role, content, toolName, createdAt }] }` — oldest first, capped at 100 rows. The select is deliberately narrow: `toolArgs`, `toolResult` and `metadata` are never fetched, so the chat UI cannot render operational internals.
- **400** `AGENT_INVALID_INPUT` (`:id` not a positive integer) · **404** `AGENT_CONVERSATION_NOT_FOUND` (missing, or owned by another admin — `NOT_OWNED` is reported as 404, never 403).

### `POST /admin/agent/approvals` — ADMIN
- **Body**: `toolName` (must match `/^[a-z][a-z0-9_]{2,63}$/`), `args` (plain object), `conversationId?`, `ttlMs?`.
- **201** `{ success: true, data: { id, toolName, argsHash, status, expiresAt } }` · **400** `AGENT_APPROVAL_INVALID_INPUT` (bad tool name, non-serialisable args, `ttlMs` outside 30 000..1 800 000).
- `args` is **not** echoed back — the response carries only `argsHash`.
- `ttlMs` is optional and defaults to `config.aiAgent.approvalTtlMs` (5 min, already clamped to exactly the 30 s..30 min the service enforces).
- **Fixed in Phase 4.5.** This endpoint shipped returning **500 for every request**: the route called `requestApproval({ … })` while the module's destructured require pulled only `decideApproval`, `getApproval` and `AgentApprovalError`, so the call threw `ReferenceError` (not an `AppError`, so the global handler answered 500 with no `code`). A second, quieter defect sat behind it: `ttlMs` was documented optional but `requestApproval` rejects a non-integer value, so even with the import fixed every request without an explicit TTL returned 400. Both are fixed, and `tests/agent-rest.test.js` now walks create → read → decide (the absence of any test for this endpoint is why both defects survived).
- Purpose (from the source): the agent itself creates most of these rows when a refused mutation becomes a request; the endpoint exists to make the flow testable and to let a dashboard retry a request that expired before it was decided.


### `POST /admin/agent/approvals/:id/decide` — ADMIN
- **Body**: `approved` — must be exactly `true` or `false`.
- **200** `{ success: true, data: { id, status, decidedAt, decidedBy } }` (`status` = `APPROVED` | `REJECTED`). Deciding is idempotent in outcome but not in history: a second decision on a non-`PENDING` row is refused rather than silently accepted.
- **400** `AGENT_INVALID_INPUT` (`:id` not a positive integer, or `approved` not a boolean).
- **404** `AGENT_APPROVAL_NOT_FOUND` (no such row) · `AGENT_APPROVAL_NOT_OWNED` (another admin's row).
- **409** `AGENT_APPROVAL_EXPIRED`, `AGENT_APPROVAL_REJECTED`, `AGENT_APPROVAL_ALREADY_CONSUMED`, `AGENT_APPROVAL_NOT_PENDING` — every `AgentApprovalError` code other than `NOT_FOUND`/`NOT_OWNED` is mapped to 409.

### `GET /admin/agent/approvals/:id` — ADMIN
- **200** `{ success: true, data: { id, toolName, argsHash, status, requestedAt, expiresAt, decidedAt, consumedAt, conversationId } }` — deliberately **no `args`**: the raw arguments may carry PII-adjacent values and the `argsHash` is what proves the binding.
- **400** `AGENT_INVALID_INPUT` (`:id` not a positive integer) · **404** `AGENT_APPROVAL_NOT_FOUND` (missing *or* another admin's row — `getApproval` returns `null` for both).

### Response envelope — and the `200` + `ok: false` rule

The agent uses the repo's `{ success, error }` shape **plus** an `ok` flag, because an assistant turn can fail in ways that are not HTTP errors (a refused model answer, an exhausted tool budget, a provider outage). Those return **200 with `ok: false`** rather than a misleading 5xx, so a dashboard cannot mistake them for a broken endpoint; only `AGENT_DISABLED` is a **503**.

| Turn outcome | HTTP | Body |
|---|---|---|
| Answered | 200 | `{ success: true, ok: true, answer, source, conversationId, detail }` |
| Expected agent failure | 200 | `{ success: true, ok: false, code, message, conversationId, declinedReason, ungrounded }` |
| Agent disabled | 503 | the same `ok: false` body with `code: 'AGENT_DISABLED'` |
| Bad request / not found / conflict | 400 · 404 · 409 | `{ success: false, error, code }` (global handler) |

Turn-result codes returned by `answerQuestion` (`src/services/agent/agentService.js`) — every one of these rides `success: true`:

| `code` | HTTP | Meaning |
|---|---|---|
| `AGENT_DISABLED` | 503 | `config.aiAgent.enabled` is false when the service runs (routes are normally unmounted, so this is a defence-in-depth path) |
| `EMPTY_QUESTION` | 200 | `question` is not a non-empty string |
| `LLM_NOT_CONFIGURED` | 200 | neither `GROQ_API_KEY` nor `GEMINI_API_KEY` resolved and the deterministic fast path declined |
| `LLM_UNAVAILABLE` | 200 | the graph threw `ALL_PROVIDERS_FAILED` — every configured provider failed *transiently* |
| `LLM_ERROR` | 200 | any other graph/provider throw, including a **permanent** provider error (bad key, malformed request). A **retired model id** (`404 model_not_found`) lands here on committed HEAD because the failover wrapper does not retry 404s (see `llmProvider.isRetriable`); an in-flight Phase 4.5 change instead retires that provider for the process and falls through to the fallback, which surfaces as `LLM_UNAVAILABLE` once no usable provider is left |
| `TOOL_BUDGET_EXHAUSTED` | 200 | the model ended with `stopReason: 'MAX_TOOL_CALLS'` and produced no prose |
| `EMPTY_ANSWER` | 200 | the model ended without prose for any other reason |
| `GROUNDING_FAILED` | 200 | the answer contained figures no tool returned; the payload adds `ungrounded: [...]` and the answer is discarded |

- `conversationId` and `declinedReason` are present on failures where known; `ungrounded` only on `GROUNDING_FAILED`.
- `message` is Arabic (e.g. `'ميزة المساعد الذكي غير مُفعّلة.'` for `AGENT_DISABLED`), matching the deterministic tier's answers.
- Throwing is reserved for real bugs — these eight are documented outcomes, not errors.

### Route-level error codes

Thrown as `AppError` and shaped by the global handler as `{ success: false, error, code }`:

| `code` | HTTP | Thrown by |
|---|---|---|
| `AGENT_QUESTION_REQUIRED` | 400 | `POST /ask` — missing/blank `question` |
| `AGENT_QUESTION_TOO_LONG` | 400 | `POST /ask` — `question` over 2000 characters |
| `AGENT_INVALID_INPUT` | 400 | `POST /ask` (`conversationId`/`approvalId`), `GET /conversations/:id/messages` (`:id`), `POST /approvals/:id/decide` (`:id`, `approved`) |
| `AGENT_CONVERSATION_NOT_FOUND` | 404 | `GET /conversations/:id/messages` — `AgentConversationError('NOT_OWNED')` |
| `AGENT_APPROVAL_NOT_FOUND` | 404 | `POST /approvals/:id/decide`, `GET /approvals/:id` |
| `AGENT_APPROVAL_NOT_OWNED` | 404 | `POST /approvals/:id/decide` — another admin's row |
| `AGENT_APPROVAL_EXPIRED` | 409 | `POST /approvals/:id/decide` — TTL elapsed |
| `AGENT_APPROVAL_REJECTED` | 409 | `POST /approvals/:id/decide` — already rejected |
| `AGENT_APPROVAL_ALREADY_CONSUMED` | 409 | `POST /approvals/:id/decide` — grant already spent |
| `AGENT_APPROVAL_NOT_PENDING` | 409 | `POST /approvals/:id/decide` — any other non-`PENDING` state |
| `AGENT_APPROVAL_INVALID_INPUT` | 400 | `POST /approvals` — bad `toolName` / `args` / `ttlMs` |

- The `AGENT_APPROVAL_*` codes are built as `AGENT_APPROVAL_${err.code}` from the stable codes of `AgentApprovalError`: `INVALID_INPUT`, `NOT_FOUND`, `NOT_OWNED`, `REJECTED`, `EXPIRED`, `ALREADY_CONSUMED`, `NOT_PENDING`. (`TOOL_MISMATCH` and `ARGS_MISMATCH` exist in the service but are raised only by the consumption gate inside a turn, never by a route.)
- Status mapping differs per route: `POST /approvals` maps **every** `AgentApprovalError` to **400**, while `POST /approvals/:id/decide` maps `NOT_FOUND`/`NOT_OWNED` to **404** and everything else to **409**.

### WebSocket (`/agent-ws`)

`socket.io` attached to the same listening HTTP server by `initAgentSocket(server)` (called from the `app.listen()` callback), created with `path: '/agent-ws'` — clients connect to the default namespace at that path. Connection options: `credentials: true`, `methods: ['GET', 'POST']`, and an origin callback that reuses `isAllowedOrigin` from `src/config/cors.js` (a handshake with no `Origin` is allowed; anything else is rejected with `ORIGIN_NOT_ALLOWED`). Only when `AI_AGENT_ENABLED` is true.

**Handshake auth — cookie-only, then a DB admin re-check** (`io.use(authenticateSocket)`):

1. Read the token from the `accessToken` cookie, or the legacy `token` cookie. There is **no `Authorization: Bearer` fallback** — a browser chat sends cookies, so this surface deliberately trusts nothing else.
2. `jwt.verify(token, config.jwt.secret)` and require `decoded.type === 'access'`.
3. Re-check the user in the database (`prisma.user.findUnique`, `select: { id, role, name }`) and require `role === 'ADMIN'` — the same DB re-check `authorizeAdmin()` performs for REST.
4. On success the socket carries `socket.agent = { adminId, adminName }` (namespaced on purpose: `socket.user` is deliberately left unused).

| Rejection (`next(new Error(...))`) | Cause |
|---|---|
| `AUTH_REQUIRED` | no `accessToken`/`token` cookie on the handshake |
| `INVALID_TOKEN` | signature/expiry failure, or a decoded token whose `type` is not `access` |
| `ADMIN_REQUIRED` | user no longer exists, or `role !== 'ADMIN'` |
| `AUTH_FAILED` | any other throw from verify or the DB lookup |

**Client → server**

| Event | Payload | Effect |
|---|---|---|
| `agent:message` | `{ question, conversationId?, approvalId? }` | Runs one persisted turn; answers with `agent:complete` |
| `agent:decide` | `{ approvalId, approved }` | Approve/reject one pending request; answers with `agent:decision` |
| `agent:conversations` | — (payload ignored) | Answers with `agent:conversations` (30 most recent) |
| `agent:history` | `{ conversationId }` | Answers with `agent:history` (transcript) |

**Server → client**

| Event | Payload |
|---|---|
| `agent:thinking` | a progress object: `{ type: 'thinking', status: 'started' }` or `{ type: 'tier', tier: 'deterministic' \| 'llm', intent? \| declinedReason? }` |
| `agent:tool_call` | `{ type: 'tool_call', name, args }` — the **model's own** requested call, not a tool payload |
| `agent:tool_result` | `{ type: 'tool_result', name, ok }` — outcome flag only |
| `agent:complete` | the full turn result: `{ ok: true, source, answer, conversationId, detail }` or `{ ok: false, code, message, conversationId, … }`. Note this is **not** the REST `{ success, ok, … }` envelope — the service result is emitted as-is, so an expected failure still arrives as one `agent:complete` with `ok: false` (never an `agent:error`) |
| `agent:error` | `{ code, detail }` |
| `agent:conversations` | `{ conversations: [{ id, title, updatedAt, lastMessageAt, messageCount }] }` |
| `agent:history` | `{ conversationId, messages: [{ id, role, content, toolName, createdAt }] }` |
| `agent:decision` | `{ approvalId, status, decidedBy, decidedAt }` |

⚠ The header comment block of `socketHandler.js` lists an `agent:tier` event, but **no such event is ever emitted**: the handler forwards both `thinking` and `tier` progress objects through `agent:thinking` (`if (event.type === 'thinking' || event.type === 'tier') forwardProgress('agent:thinking')(event)`). Clients should read `agent:thinking` and switch on `type`/`tier`.

**Per-event validation → `agent:error`**

| Condition | `code` |
|---|---|
| `agent:message` with a blank `question`, or one longer than 2000 characters | `EMPTY_QUESTION` |
| `agent:message` whose turn handler threw | `AGENT_ERROR` |
| `agent:history` without a positive integer `conversationId` | `INVALID_CONVERSATION` |
| `agent:history` for a conversation that is missing or another admin's | `CONVERSATION_NOT_FOUND` |
| `agent:history` / `agent:conversations` read failed for any other reason | `HISTORY_FAILED` |
| `agent:decide` without a positive `approvalId` and a boolean `approved` | `INVALID_DECISION` |
| `agent:decide` on an expired approval | `APPROVAL_EXPIRED` |
| `agent:decide` on a missing / other admin's approval | `APPROVAL_NOT_FOUND` |
| `agent:decide` on a rejected / already-consumed / non-pending approval | `APPROVAL_ALREADY_DECIDED` |
| `agent:decide` failed for any other reason | `DECISION_FAILED` |
| handler registration itself threw (the socket is then disconnected) | `HANDLER_FAILED` |

Every handler resolves — a throwing handler is caught and turned into `agent:error` rather than a silently detached socket.

**Two deliberate design rules**

1. **Answer content is never streamed.** There is no `agent:token` word-stream, because the grounding guard (`answerGuard.checkGrounded`) can only validate a *complete* answer — a token shown before validation would defeat the whole check. Progress events (`agent:thinking`, `agent:tool_call`, `agent:tool_result`) are live; the answer itself arrives once, validated, inside `agent:complete` — or not at all.
2. **Tool payloads are never sent to the browser.** `agent:tool_result` carries only a tool name and an `ok` flag, because raw payloads would duplicate the redaction surface into the client. The transcript endpoint is narrowed the same way (no `toolArgs` / `toolResult` / `metadata`).