# E-Learning Platform — Project Map

## Overview

A full-stack e-learning platform for Egyptian secondary school students. Courses contain videos (hosted on Bunny.net Stream), quizzes (SurveyJS-based), and assignments. Students progress sequentially through course content. Admins manage everything.

**Tech Stack**: Node.js/Express, MySQL 8.0 (Prisma ORM), Bunny.net Stream (video hosting), JWT (cookie-based auth), Busboy (multipart uploads).

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
| `scripts/checkDbTables.js` | List MySQL tables |
| `scripts/testBunnyIntegration.js` | Unit tests for Bunny client |
| `scripts/testQuizLogic.js` | Unit tests for quiz service |
| `scripts/testQuizFlow.js` | E2E quiz flow test |
| `scripts/testImports.js` | Module import smoke test (stale — references youtubeRoutes) |

---

## Known Issues

### Critical Bugs (fix immediately)
1. **`previousVideo` undefined** — `sequentialAccess.js:76` references `previousVideo` but `evaluateGate` returns `previousVideoId`. Will throw `ReferenceError` at runtime. **Confirmed: never tested.**
2. **`evaluateGate` only queries `BunnyVideo`** — legacy Video courses are completely locked for students. `evaluateGate` does `prisma.bunnyVideo.findUnique({ where: { id: videoId } })` — a legacy Video ID won't be found. **Confirmed: unaware, serious bug.**
3. **`deleteCourse` doesn't clean up Bunny remote** — deletes DB rows but never calls `bunnyClient.deleteVideo()`. Orphaned videos on Bunny servers cost money. **Confirmed: unaware, needs remote cleanup.**
4. **`submitAttempt` ternary is dead code** — both branches identical (`mcqEarned` / `computeScorePercent(mcqEarned, totalPoints)`). Essay score always 0 at submission. **Confirmed: needs actual essay point accumulation.**

### Schema/Design Gaps (fix before launch)
5. **No `position` on `BunnyVideo`** — videos ordered by `createdAt` only, can't reorder. **Confirmed: needs schema migration + reorder API.**
6. **`answerKey` stored raw in DB** — no encryption. **Confirmed: leave for now, document risk.**
7. **Quiz retake logic undefined** — no max attempts, no retake flow. `startAttempt` resumes existing `IN_PROGRESS`. **Confirmed: needs proper max-attempts and retake logic.**
8. **`User.grade` optional but required for recommendations** — students without grade get no recommendations. **Confirmed: needs fix — either optional in logic or required at signup.**
9. **Payment disabled** — free-for-all, auto-grants `isPaid`. **Confirmed: open/free now, needs locking before launch.**
10. **README completely stale** — wrong roles (mentions TEACHER), wrong quiz model (mentions `description`), outdated instructions. **Confirmed: needs full rewrite.**

### Dead Code (clean up)
11. `testImports.js` — references nonexistent `youtubeRoutes`. **Confirmed: remove.**
12. `getCookieConfig()` in `src/utils.js` — never imported anywhere. **Confirmed: remove.**
13. `videoProcessing.js` / `videoProcessingController.js` — empty placeholders. **Confirmed: needs review before deciding.**

### Noted But Not Blocking
- `createCourse` assigns to first ADMIN, not requester.
- Cookie/JWT expiry mismatch (15min cookie vs 1h token).
- Two cookie config objects (`config/cookie.js` used, `utils.js` dead).
- `getCookieConfig()` dead code.
- `accessControl.js` auto-grants `isPaid` on every request (double-duty workaround).
- README mentions `description` on Quiz model — removed when SurveyJS system replaced old quiz system.

### Planned Features (not implemented, leave for later)
- `LearningPath` model — no routes/controllers.
- `Certificate` model — no routes/controllers.
- Teacher role — doesn't exist in DB, only STUDENT/ADMIN.
- Assignments for BunnyVideo courses — not linked.
- Admin GUI for Bunny video management — only CLI scripts exist.
- Payment gateway integration — stub only.
