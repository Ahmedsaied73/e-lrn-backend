# E-Learning Platform — Project Map

## Overview

A full-stack e-learning platform for Egyptian secondary school students. Courses contain videos (hosted on Bunny.net Stream), quizzes (SurveyJS-based), and assignments. Students progress sequentially through course content. Admins manage everything.

**Tech Stack**: Node.js/Express, Postgres on Supabase (Prisma ORM), Bunny.net Stream (video hosting), JWT (cookie-based auth), Busboy (multipart uploads).

**Port**: 3005

---

## Domain Map

### Auth (`/auth/*`)
- `POST /auth/login` — email/password → JWT in httpOnly cookie + response body
- `POST /auth/register` — requires name, email, phone, password, grade
- `POST /auth/logout` — clears cookies + revokes refresh token in DB
- `POST /auth/refresh-token` — new access token from refresh token cookie
- **Quirk**: Access token cookie maxAge = 15min, but JWT expiry = 1h. Cookie vanishes before token expires.

### Users (`/user/*`)
- `GET /user/me` — current profile
- `GET /user/` — list all (admin, paginated)
- `GET /user/:userId` — get by ID (admin)
- `PUT /user/:userId` — update (self or admin)
- `DELETE /user/:userId` — delete (admin, cannot self-delete)

### Courses (`/courses/*`)
- `GET /courses/` — list all (paginated)
- `GET /courses/enrolled` — user's enrolled courses
- `GET /courses/:id` — **aggregated**: returns `{ course, videos, enrollment, progress }`
- `POST /courses/` — create (admin)
- `PUT /courses/:id` — update (admin)
- `DELETE /courses/:id` — delete with transaction (admin)
- **Quirk**: `createCourse` assigns to first ADMIN user found, not the requesting user.

### Bunny Videos (`/courses/:id/bunny-videos`, `/videos/:id/*`)
- `POST /courses/:courseId/videos` — create Bunny video record + Bunny object
- `GET /courses/:courseId/bunny-videos` — list (students see READY only, admin sees all)
- `POST /videos/:videoId/upload` — upload binary to Bunny (Busboy → stream, no temp files)
- `GET /videos/:videoId/playback` — signed embed URL (sequential access enforced)
- `DELETE /videos/bunny/:videoId` — delete from Bunny + DB

### Legacy Videos (`/videos/*`, `/stream/*`)
- `GET /videos/course/:courseId` — list videos for course
- `POST /videos/course/:courseId` — create (admin, URL-based)
- `GET /stream/video/:videoId/url` — streaming URL
- `GET /stream/video/:videoId/embed` — HTML embed
- `GET /stream/video/:videoId/next` — next video in sequence

### Quizzes (`/quizzes/*`)
- `GET /quizzes/videos/:videoId/meta` — quiz metadata
- `POST /quizzes/videos/:videoId/start` — start/resume attempt
- `PATCH /quizzes/attempts/:id/save` — save in-progress
- `POST /quizzes/attempts/:id/submit` — submit for grading
- `GET /quizzes/attempts/:id/result` — score breakdown
- `POST /quizzes/videos/:videoId` — create/update quiz (admin)
- `PUT /quizzes/attempts/:id/grade` — grade essays (admin)
- `POST /quizzes/videos/:videoId/exemptions` — gate exemption (admin)
- **One quiz per BunnyVideo** (1:1 via `bunnyVideoId` unique constraint).
- **Question types**: radiogroup (MCQ), comment (essay), html, image (non-scorable).
- **State machine**: IN_PROGRESS → SUBMITTED → GRADING (if essays) → GRADED. EXPIRED if deadline passes.

### Assignments (`/assignments/*`)
- `POST /assignments/` — create (admin, MCQ or text)
- `POST /assignments/submit` — submit answer
- `POST /assignments/submissions/:id/grade` — grade (admin)
- `GET /assignments/video/:videoId` — assignments for a video
- **Only linked to legacy Video, not BunnyVideo.** Bunny video courses cannot have assignments.

### Payments (`/payments/*`)
- `POST /payments/course/:courseId` — **STUB** (403 in production, simulated in dev)
- `GET /payments/history` — payment + enrollment history
- **Payment is disabled.** All enrollments auto-mark as paid.

### Enrollment (`/enroll/*`)
- `POST /enroll/` — enroll in course (auto-granted, payment bypassed)
- `POST /enroll/status` — check enrollment (POST, not GET)

### Progress (`/progress/*`)
- `POST /progress/complete` — mark BunnyVideo as completed
- `GET /progress/course/:courseId` — course video progress
- `GET /progress/:videoId` — video completion check
- **Operates on BunnyVideoProgress only**, not legacy VideoProgress.

### Search (`/search/*`)
- `GET /search/content` — search courses/videos (filters: category, grade, price, sort)
- `GET /search/trending` — by enrollment count
- `GET /search/recommended` — courses matching user's enrolled categories/grades

---

## Sequential Learning Flow

Students must complete prerequisites before accessing the next video:

1. **First video** in a course → always accessible
2. **Subsequent videos** → requires:
   - Previous video completion (`BunnyVideoProgress`)
   - Previous video quiz pass OR admin exemption (`GateExemption`)
   - Previous video assignment submission and grading (legacy Video system only)

**Gate evaluation**: `quizService.evaluateGate()` is the single source of truth. Admins bypass all checks.

---

## Dual Video Systems

| Aspect | Legacy `Video` | `BunnyVideo` |
|--------|---------------|-------------|
| Storage | URL reference | Bunny.net Stream |
| Upload | None (URL provided) | Binary upload via Busboy |
| Streaming | `/stream/video/:id/url` | `/videos/:id/playback` (signed) |
| Progress | `VideoProgress` (barely used) | `BunnyVideoProgress` (active) |
| Quizzes | None | SurveyJS-based, 1:1 |
| Assignments | Yes | No |
| Sequential gate | Broken (references BunnyVideo) | Working |

---

## Database Schema (Key Models)

- **User**: id, name, email, phoneNumber, password, role (STUDENT|ADMIN), grade (FIRST_SECONDARY|SECOND_SECONDARY|THIRD_SECONDARY), refreshToken
- **Course**: id, title, description, price, thumbnail, teacherId, grade, category
- **Video** (legacy): id, title, url, thumbnail, duration, position, courseId
- **BunnyVideo**: id, title, bunnyVideoId (GUID), status (PENDING|UPLOADING|PROCESSING|READY|FAILED), duration, courseId
- **Enrollment**: id, userId, courseId, isPaid, progress, isCompleted, completedAt
- **Quiz**: id, title, description, bunnyVideoId (unique), surveyJson, answerKey, passingScore, timeLimitMinutes
- **QuizAttempt**: id, quizId, userId, responses, scorePercent, status (IN_PROGRESS|SUBMITTED|GRADING|GRADED|EXPIRED), deadlineAt
- **Assignment**: id, title, videoId (legacy Video), type (MCQ|TEXT), questions, dueDate
- **Submission**: id, assignmentId, userId, content, fileUrl, score, status (PENDING|GRADED|REJECTED)
- **GateExemption**: id, userId, bunnyVideoId (unique)
- **VideoProgress**: id, userId, videoId (legacy) — barely used
- **BunnyVideoProgress**: id, userId, bunnyVideoId — actively used

---

## Background Jobs

- **Reconciliation** (`src/jobs/reconcileStaleVideos.js`): Runs every 10 minutes via `node-cron`. Finds Bunny videos stuck in PROCESSING > 30 minutes and polls Bunny API for current status.

---

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/uploadCourseFolder.js` | Bulk upload `.mp4` files to Bunny for a course |
| `scripts/uploadDemoVideos.js` | E2E demo: create course + videos + upload |
| `scripts/enrollAdminsInAllCourses.js` | Auto-enroll all admins in all courses |
| `scripts/markEnrollmentAsPaid.js` | Manually mark enrollment as paid |
| `scripts/deleteCourse1.js` | Delete course ID 1 transactionally |
| `scripts/checkDbTables.js` | List Postgres tables |
| `scripts/testBunnyIntegration.js` | Unit tests for Bunny client |
| `scripts/testQuizLogic.js` | Unit tests for quiz service |
| `scripts/testQuizFlow.js` | E2E quiz flow test |

---

## Known Issues

### Fixed in grilling round (Sept 2026) — committed on `Dev`
See `AGENTS.md` → "Bug fixes applied" and `plans/bug-fix-plan.md` for details.

- ✅ **`previousVideo` undefined** — derives `previousVideoId` from `courseVideos[currentVideoIndex - 1].id`. (`sequentialAccess.js`)
- ✅ **`evaluateGate` only handled BunnyVideo** — split into `evaluateBunnyVideoGate` / `evaluateLegacyVideoGate`; both `Video` and `BunnyVideo` unlock correctly.
- ✅ **`deleteCourse` left orphaned Bunny videos** — now calls `bunnyClient.deleteVideo()` per video (errors logged, not fatal).
- ✅ **`submitAttempt` dead ternary** — simplified; MCQ auto-graded, essay at admin grading step.
- ✅ **No `position` on `BunnyVideo`** — added `position Int?` + `PUT /courses/:courseId/reorder` (ADMIN). Ordering by `position, createdAt, id` in list/gate/progress endpoints.
- ✅ **Quiz retake logic undefined** — added `Quiz.maxAttempts @default(3)`; `startAttempt` returns 409 when exhausted; EXPIRED attempts don't burn a retake; meta exposes `maxAttempts`/`attemptsUsed`/`atMaxAttempts`.
- ✅ **`User.grade` optional** — now required (`@default(FIRST_SECONDARY)`), registration already validated it.
- ✅ **README stale** — fully rewritten for current stack.
- ✅ **Dead code** — removed `scripts/testImports.js`, `getCookieConfig()` from `utils.js`, and empty `src/routes/videoProcessing.js`, `src/controllers/videoProcessingController.js`, `src/middlewares.js`.

**Not yet applied**: the 3 migrations (`20260905000000_require_user_grade`, `20260905010000_bunny_video_position`, `20260905020000_quiz_max_attempts`) are committed but pending — run `npx prisma migrate dev` to apply + regenerate client.

### Remaining / Deliberately Open
- **`answerKey` stored raw in DB** — no encryption. Documented risk, left for now.
- **Payment disabled** — free-for-all, auto-grants `isPaid`. Needs locking before launch.
- `createCourse` assigns to first ADMIN, not requester.
- Cookie/JWT expiry mismatch (15min cookie vs 1h token).
- Two cookie config objects (`config/cookie.js` used, `utils.js` had `getCookieConfig()` — removed).
- `accessControl.js` auto-grants `isPaid` on every request (double-duty workaround).
- `GET /search/recommended` depends on `User.grade` — now guaranteed present.

### Planned Features (not implemented, leave for later)
- `LearningPath` model — no routes/controllers.
- `Certificate` model — no routes/controllers.
- Teacher role — doesn't exist in DB, only STUDENT/ADMIN.
- Assignments for BunnyVideo courses — not linked.
- Admin GUI for Bunny video management — only CLI scripts exist.
- Payment gateway integration — stub only.
