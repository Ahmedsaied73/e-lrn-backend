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
- [16. Health Probes (`/healthz`, `/readyz`, `/health`)](#16-health-probes-healthz-readyz-health)
- [17. Sequential Access Gate](#17-sequential-access-gate)
- [18. Error Codes](#18-error-codes)

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
| `User` | `u_` + random hex (opaque, non-enumerable) | `{ id, slug, name, ... }` — **both** kept (id needed by deferred admin surfaces) | kept |
| `Course` | readable slug (`course-1`, `course-...`) | `{ slug, ... }` — `id`/`teacherId` **removed** | internal only |
| `BunnyVideo` | readable slug (`video-1`, `video-...`) | `{ slug, courseSlug, quizSlug | null, ... }` — `id`, `courseId`, `bunnyVideoId` **removed** | internal only |
| `Quiz` | readable slug (`quiz-1`, `quiz-...`) | `{ slug, videoSlug, ... }` — `id`, `bunnyVideoId` **removed** | internal only |

- `User` slugs are **opaque** (`u_...`) and can NOT be enumerated/guessed; course/video/quiz slugs are readable and used in browser URLs.
- Route params are slugs everywhere for these resources, e.g. `GET /courses/:slug`, `POST /progress/complete { videoSlug }`. **No redirect shim** — old numeric URLs now `404`.
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
- **400** `Invalid user slug.` (malformed `u_...`) · **404** `User not found.`

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

## 16. Health Probes (`/healthz`, `/readyz`, `/health`)

Mounted **before** the global rate limiter — never throttled, no auth.

### `GET /healthz`
- **200** `{ status: 'ok', uptime: <sec> }` — liveness, zero I/O.

### `GET /readyz`
- **200** `{ status: 'ok', db: 'up', uptime, ms }` · **503** `{ status: 'error', db: 'down', ms }` — DB ping (3s timeout). Redis never gates readiness.

### `GET /health`
- **200** `{ status: 'ok', db: 'up', uptime, ms }` · **503** — legacy DB-ping healthcheck (test harness / CI compatible).

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