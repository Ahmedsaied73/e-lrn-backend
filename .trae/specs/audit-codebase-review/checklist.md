# Checklist

## P0 — Critical
- [ ] POST /enroll no longer sets `isPaid: true` without verified payment (enrollmentController.js)
- [ ] GET /courses/:id omits playable video URLs for non-enrolled/non-paid users (coursesController.js)
- [ ] Resubmitting a graded MCQ assignment returns 400 WITHOUT deleting existing answers (verified order of guard vs deleteMany)
- [ ] GET /search/content?q=... returns results on MySQL without PrismaClientValidationError (no `mode:'insensitive'`)

## P1 — High
- [ ] Student GET /assignments/:id response contains no `correctOption` / `explanation` fields before first submission
- [ ] Refresh token verified with a secret distinct from access token; using a refresh token against protected routes fails
- [ ] Login/refresh JSON bodies no longer contain refreshToken; refresh rotates the stored token
- [ ] Schema has `@@unique([userId, courseId])` on Enrollment with a valid migration; duplicate enroll returns 409

## P2 — Medium
- [ ] `npm start` works locally (node app.js); docker-compose passes JWTSECRET
- [ ] helmet() mounted; trust proxy set
- [ ] Migration applies cleanly: Decimal money columns + question-table indexes exist

## Regression sanity
- [ ] Admin can still create/upload/delete Bunny videos (routes unchanged)
- [ ] Paid-enrolled student can still fetch course with URLs, submit quiz/assignment, see progress
