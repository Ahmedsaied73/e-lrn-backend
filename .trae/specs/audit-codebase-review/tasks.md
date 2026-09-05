# Tasks

- [ ] Task 1 (P0): Fix paywall bypass in enrollment
  - [ ] 1.1: In `enrollmentController.js`, stop auto-setting `isPaid: true` — create enrollments as `isPaid: false`; remove the unpaid→paid flip unless a verified payment reference is provided.
- [ ] Task 2 (P0): Enforce enrollment gate on course videos
  - [ ] 2.1: In `coursesController.getCourseById`, strip/nullify video `url` when requester lacks paid enrollment and is not ADMIN.
- [ ] Task 3 (P0): Stop data loss on graded-MCQ resubmission
  - [x] 3.1: Move the graded-status guard above the `deleteMany`; wrap delete+createMany+submission update/create in one `$transaction`.
- [ ] Task 4 (P0): Fix search crash on MySQL
  - [x] 4.1: Remove `mode: 'insensitive'` from both queries in `searchController.js`.
- [ ] Task 5 (P1): Stop MCQ answer leakage in assignments
  - [ ] 5.1: In `assignmentController.getAssignment`, select only `id, text, options, points` for students; include `correctOption/explanation` only for admins or after submission exists.
- [ ] Task 6 (P1): Separate refresh-token secret
  - [ ] 6.1: Sign refresh tokens with distinct secret + `type: 'refresh'` claim; reject refresh tokens in `authenticateToken`; add `REFRESH_TOKEN_SECRET` to `.env.example`.
- [ ] Task 7 (P1): Stop returning tokens in JSON body + rotate refresh token
  - [ ] 7.1: Remove refreshToken from login/refresh response bodies; issue new refresh token (DB update) on each successful refresh.
- [ ] Task 8 (P1): Enrollment unique constraint
  - [ ] 8.1: Add `@@unique([userId, courseId])` to Enrollment in schema.prisma + migration; handle P2002 as 409 in enroll/payment controllers.
- [ ] Task 9 (P2): Deployment fixes
  - [ ] 9.1: Add `"start": "node app.js"` script; fix compose env var name to `JWTSECRET`.
- [ ] Task 10 (P2): Security headers & proxy config
  - [ ] 10.1: Add helmet middleware; set `app.set('trust proxy', 1)`.
- [ ] Task 11 (P2): DB hygiene migration
  - [ ] 11.1: One migration: money → `Decimal(10,2)` (Course.price, Payment.amount); add `@@index([quizId])`, `@@index([assignmentId])`.

# Task Dependencies
- Task 8 should land before/with Tasks 1–2 (duplicate enrollments would undermine the gate).
- Tasks 6–7 are coupled (same files).
- All other tasks are independent and parallelizable.
