# Codebase Audit & Fix Plan Spec

## Why
A full-codebase review of the e-learning platform (Express + Prisma/MySQL + Bunny Stream) found **2 critical paywall/security holes**, several data-integrity bugs, one guaranteed runtime crash (MySQL search), and deployment blockers. This spec documents findings and defines a minimal fix plan.

## Architecture Summary (what exists today)
- Express 4 monolith (`app.js`) → routes → controllers → Prisma 5 (MySQL). JWT access+refresh in HttpOnly cookies, bcrypt, ADMIN-only course/video management.
- Bunny Stream integration: create video record → busboy stream upload → webhook (`express.raw` + HMAC `timingSafeEqual`, mounted before `express.json()` — done correctly) → node-cron reconcile job every 10 min.
- Domains: courses, enrollment, payments (simulated stub — **no Stripe anywhere**), quizzes, MCQ assignments, search, video progress.
- Data model: User → Enrollment/Payment/Certificate/VideoProgress/Answer/Submission; Course → Video/BunnyVideo/Quiz/Assignment/LearningPath.

## What Changes

### P0 — Critical (paywall broken)
1. **Enrollment paywall bypass** — [enrollmentController.js](file:///c:/Users/os/Desktop/e-learning-platform/src/controllers/enrollmentController.js#L36-L52): any user self-activates paid enrollment (`isPaid` hardcoded `true`, unpaid enrollment flipped to paid with zero payment verification).
   - FIX: Create enrollments as `isPaid: false`; require a verified payment reference before activation.
2. **Video URLs leaked to non-enrolled users** — [coursesController.js](file:///c:/Users/os/Desktop/e-learning-platform/src/controllers/coursesController.js#L68-L106): `getCourseById` returns playable `url` for every video of any course; enrollment is fetched but never enforced.
   - FIX: Strip/nullify `url` unless requester has `isPaid` enrollment or is ADMIN.

### P0 — Critical (data loss / crash)
3. **Graded-MCQ resubmission deletes answers then rejects** — [assignmentController.js](file:///c:/Users/os/Desktop/e-learning-platform/src/controllers/assignmentController.js#L266-L275): `deleteMany` runs *before* the graded-status guard at L311-315 → student loses saved answers permanently on a rejected retry.
   - FIX: Move the graded guard above the delete; wrap delete+create+update in `$transaction`.
4. **Search crashes on MySQL** — [searchController.js](file:///c:/Users/os/Desktop/e-learning-platform/src/controllers/searchController.js#L41-L42): `mode: 'insensitive'` is PostgreSQL/Mongo-only; on MySQL every search request 500s.
   - FIX: Drop `mode` (MySQL default collation is already case-insensitive).

### P1 — High (security & integrity)
5. **MCQ correct answers leaked pre-submission** — [assignmentController.js](file:///c:/Users/os/Desktop/e-learning-platform/src/controllers/assignmentController.js#L108): raw `AssignmentQuestion: true` include returns `correctOption`/`explanation` to students (quiz domain does this correctly; assignment domain doesn't).
   - FIX: Select only `id, text, options, points` until a submission exists / admin.
6. **Access & refresh tokens share one secret** — refresh token accepted wherever access token works; configured `REFRESH_TOKEN_SECRET` is dead code ([utils.js](file:///c:/Users/os/Desktop/e-learning-platform/src/utils.js#L7-L8), env.js).
   - FIX: Sign refresh tokens with distinct secret + `type:'refresh'` claim rejected by `authenticateToken`.
7. **Refresh token also returned in JSON body**, defeating HttpOnly cookie design ([authController.js](file:///c:/Users/os/Desktop/e-learning-platform/src/controllers/authController.js#L43)).
   - FIX: Return only user payload; rely on cookies. Also add basic refresh-token rotation on `/auth/refresh`.
8. **No `@@unique([userId, courseId])` on Enrollment** — parallel requests create duplicate enrollments (schema.prisma ~L90).
   - FIX: Add unique constraint via migration; switch findFirst-then-create to upsert/P2002 handling.
9. **Payment + enrollment activation not transactional, no idempotency** — [paymentController.js](file:///c:/Users/os/Desktop/e-learning-platform/src/controllers/paymentController.js#L52-L80): failure after payment insert leaves orphaned COMPLETED payment; retries double-insert.
   - FIX: Wrap in `prisma.$transaction`; dedupe on gateway intent id.

### P2 — Medium (hardening / hygiene)
10. Deployment broken: Dockerfile runs `npm start` but package.json has no `start` script; docker-compose sets `JWT_SECRET` while code reads `JWTSECRET`; MySQL root/"password" exposed on host port.
11. No `helmet`; no `trust proxy` behind reverse proxy (rate limiter throttles everyone collectively).
12. Money as `Float` (Course.price, Payment.amount) → move to `Decimal(10,2)` when payments go real.
13. Missing indexes `@@index([quizId])` / `@@index([assignmentId])` on question tables.
14. `getCourseAssignments` skips the enrollment gate its siblings enforce (metadata leak, low).
15. Empty dead files: `src/middlewares.js`, `src/routes/videoProcessing.js`, `src/controllers/videoProcessingController.js` (0 bytes); `scripts/testImports.js` imports the empty middlewares and crashes.
16. `gradeSubmission` rejects legitimate grade of 0 (falsy check), accepts unbounded grades/arbitrary status.
17. Concurrent quiz double-submit surfaces as 500 instead of the friendly 409 (P2002 uncaught).

## Things Done Well (keep as-is)
- Bunny webhook: raw-body HMAC verification mounted before `express.json()`, `timingSafeEqual`.
- Quiz domain correctly strips `correctOption`/`explanation` from student responses.
- Anti-N+1 single-query course fetch with user-scoped progress/enrollment includes.
- Server-authoritative pricing (`amount: course.price` from DB); strong unique constraints on Submission/Answer/Certificate.
- Fail-fast env validation; global error handler never leaks stack traces.

## Impact
- Affected specs: none (first audit spec).
- Affected code: `src/controllers/{enrollmentController,coursesController,assignmentController,searchController,paymentController,authController}.js`, `src/utils.js`, `prisma/schema.prisma` (+1 migration), `package.json`, `docker-compose.yml`, `app.js`.

## ADDED Requirements

### Requirement: Paywall Enforcement
The system SHALL NOT return playable video URLs to users without an active (`isPaid`) enrollment; enrollment creation SHALL NOT set `isPaid=true` without verified payment.

#### Scenario: Non-enrolled user fetches course
- **WHEN** an authenticated user without paid enrollment calls GET /courses/:id
- **THEN** video objects are returned WITHOUT `url` values (metadata only).

#### Scenario: Free enrollment attempt
- **WHEN** a user enrolls in a course
- **THEN** enrollment is created with `isPaid: false` unless a verified payment record exists.

### Requirement: Answer Data Integrity
Resubmission of an already-graded assignment SHALL be rejected BEFORE any stored answers are modified.

#### Scenario: Graded assignment retry
- **WHEN** a student submits answers for an already GRADED assignment
- **THEN** API returns 400 AND existing answers/submission remain untouched.

### Requirement: Correct Answers Not Leaked Pre-Submission
Student-facing assignment payloads SHALL exclude `correctOption` and `explanation` until the user has a recorded submission (admin exempt).

### Requirement: Token Separation
Refresh tokens SHALL use a distinct secret and SHALL be rejected by access-token authentication middleware; tokens SHALL NOT be duplicated into JSON response bodies.

### Requirement: Enrollment Uniqueness
The database SHALL enforce at most one Enrollment per (userId, courseId).

## REMOVED Requirements
None.
