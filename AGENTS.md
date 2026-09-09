# AGENTS.md

## Project

Node.js/Express e-learning platform for Egyptian secondary school students. Courses contain videos (Bunny.net Stream), quizzes (SurveyJS), and assignments. Students progress sequentially. Admins manage everything.

**Stack**: Express, Postgres on Supabase (Prisma ORM), Bunny.net Stream, JWT cookies, Busboy. Port **3005**.

## Commands

- `npm run dev` — start dev server (nodemon, watches `app.js`)
- `npm run db:setup` — `prisma migrate deploy && prisma generate`
- `npx prisma migrate dev --name <name>` — create new migration
- `npx prisma studio` — browse database

No test framework, linter, or formatter is configured. No CI workflows exist.

## SWE Workflow

For any non-trivial task, follow this workflow:

```
1. PLAN  →  2. GRILL  →  3. EXECUTE  →  4. REVIEW  →  5. VERIFY
```

- **Plan**: Research, understand scope, write execution plan
- **Grill**: Challenge assumptions, expose gaps (use `grill-me` skill)
- **Execute**: Implement task-by-task, minimal changes
- **Review**: Check diff for breaking changes, security, conventions
- **Verify**: Test in browser with Playwright (use `playwright-skill`)

Trivial fixes (typo, single-line) skip to step 3.

## Skills

| Skill | Location | Purpose |
|-------|----------|---------|
| `grill-me` | `~/.agents/skills/grill-me/` | Challenge plans before execution |
| `playwright-skill` | `~/.agents/skills/playwright-skill/` | Browser automation and verification |
| `swe-workflow` | `.opencode/skills/swe-workflow/` | Full workflow orchestration |

### Playwright Setup

```bash
# Run once to install Chromium
cd ~/.agents/skills/playwright-skill && npm run setup
```

### Using Playwright

```bash
# Detect running servers
node -e "require('C:/Users/Ahmed Saied/.agents/skills/playwright-skill/lib/helpers').detectDevServers().then(s => console.log(JSON.stringify(s)))"

# Run a test script
node "C:/Users/Ahmed Saied/.agents/skills/playwright-skill/run.js" /tmp/playwright-test-*.js
```

## Architecture

```
app.js                  → Express entry, mounts all routes, CORS, rate limiting
src/routes/             → Route files (one per domain)
src/controllers/        → Request handlers
src/services/           → Business logic (bunnyVideoService, quizService)
src/middlewares/        → auth (JWT cookie + Bearer), role, sequential-access, logger
src/config/             → DB, env, cookie, quiz config, admin setup
src/integrations/       → Bunny.net Stream client
src/jobs/               → Background jobs (video reconciliation every 10 min)
src/utils.js            → JWT helpers (createToken, createRefreshToken)
src/utils/AppError.js   → Error class for Bunny service layer
scripts/                → CLI utilities (enrollment, upload, admin scripts)
prisma/schema.prisma    → Single schema, Postgres on Supabase
```

## Key conventions

- **Module system**: CommonJS (`require`/`module.exports`), not ESM.
- **Env**: `.env` loaded via `dotenv` (referenced in `.env.example`). Never commit `.env`.
- **Auth**: JWT stored in httpOnly cookies (`accessToken` or `token`). `authenticateToken` middleware checks cookie first, then `Authorization: Bearer` header.
- **Error handling**: Bunny service layer uses `AppError` from `src/utils/AppError.js` → global handler in `app.js:128` returns `{ success: false, error, code }`. Quiz service uses ad-hoc `Object.assign(new Error(...), { statusCode })`. Legacy routes use raw `res.status().json()`.
- **Bunny webhook**: Mounted at `/webhooks/bunny/stream` *before* `express.json()` in `app.js:68` — it needs raw body for HMAC verification. Do not reorder.
- **Rate limiting**: 1000 req/15min global (raised from 100 on Sept 8 2026 — it starved tab-heavy browsing and test suites), 20 req/15min on `/auth/login`.
- **CORS**: Allowlisted origins only (localhost:3000, localhost:3002, `FRONTEND_URL`).
- **Database**: Supabase Postgres for all envs (pooled `DATABASE_URL` 6543 + `DIRECT_URL` 5432 for migrations). Prisma schema uses `Autoincrement()` IDs. Run `npm run db:setup` after schema changes. Legacy MySQL backup: `C:\Users\AHMEDS~1\AppData\Local\Temp\opencode\mysql-backup-20260909.sql` (local only, never committed).
- **Response envelope**: Newer endpoints use `{ success: true, data }`. Legacy endpoints return raw objects.

## Dual video systems (critical)

The codebase has **two parallel video systems** with different capabilities:

| Aspect | Legacy `Video` | `BunnyVideo` |
|--------|---------------|-------------|
| Storage | URL reference | Bunny.net Stream |
| Upload | None (URL provided) | Binary upload via Busboy → stream to Bunny |
| Streaming | `/stream/video/:id/url` | `/videos/:id/playback` (signed embed) |
| Progress | `VideoProgress` (barely used) | `BunnyVideoProgress` (active) |
| Quizzes | None | SurveyJS-based, 1:1 relationship |
| Assignments | Yes (MCQ + text) | No (not yet implemented) |
| Sequential gate | Broken (queries BunnyVideo) | Working |

**Progress tracking, quizzes, and sequential access operate on `BunnyVideo`**, not legacy `Video`. The legacy `Video` model is used for the `/stream` routes and assignments.

## Sequential learning flow

Students must complete prerequisites before accessing the next video:

1. **First video** in a course → always accessible
2. **Subsequent videos** → requires previous video completion (`BunnyVideoProgress`), previous quiz pass OR admin exemption (`GateExemption`), and (for legacy videos) assignment submission.

**Gate evaluation**: `quizService.evaluateGate()` in `src/services/quizService.js` is the single source of truth. Admins bypass all checks.

## Bunny Stream integration

- **All Bunny HTTP calls** go through `src/integrations/bunny/bunnyStreamClient.js` — no other file makes direct HTTP calls to Bunny.
- **Video state machine**: `PENDING → UPLOADING → PROCESSING → READY | FAILED`. Re-upload from `FAILED` is allowed.
- **Upload**: `POST /videos/:videoId/upload` streams binary directly to Bunny via Busboy → native `https.request`. No temp files.
- **Signed playback**: `GET /videos/:videoId/playback` generates HMAC-SHA256 signed embed URL (6h TTL).
- **Webhook**: `POST /webhooks/bunny/stream` handles status updates. Verifies HMAC signature before parsing JSON.
- **Reconciliation job** (`src/jobs/reconcileStaleVideos.js`): Polls Bunny every 10 minutes for videos stuck in PROCESSING > 30 min.

## Gotchas

- No `npm start` script defined in package.json — the Dockerfile references it but it will fail. Use `node app.js` or `npm run dev`.
- Admin auto-created on startup via `src/config/setupAdmin.js` (email from `ADMIN_EMAIL` env).
- `uploads/` directory is used for local file storage (e.g., assignment submissions).
- Port 3005 is used everywhere (app.js, Dockerfile, docker-compose.yml).
- **Payment is disabled**: All enrollments auto-mark as paid. Payment controller returns 403 in production. Access control middleware auto-grants `isPaid` on every request.
- **`createCourse` teacher attribution**: Always assigns to first ADMIN user found, not the requesting user.
- **Cookie/JWT expiry mismatch**: Access cookie maxAge = 15min, but JWT expiry = 1h.

## Bug fixes applied (grilling round, Sept 2026)

All 11 confirmed bugs are **fixed and committed on `Dev`** (see `plans/bug-fix-plan.md`). Summary:

| # | Fix | Where |
|---|-----|-------|
| 1.1 | `previousVideo` undefined → derived from `courseVideos[currentVideoIndex - 1].id` | `src/middlewares/sequentialAccess.js` |
| 1.2 | `evaluateGate` supports both `Video` and `BunnyVideo` (split into `evaluateBunnyVideoGate` / `evaluateLegacyVideoGate`) | `src/services/quizService.js` |
| 1.3 | `deleteCourse` cleans up Bunny remote videos (per-video, errors logged not fatal) | `src/controllers/coursesController.js` |
| 1.4 | `submitAttempt` dead ternary simplified (MCQ now, essay at grading) | `src/services/quizService.js` |
| 2.3 | `User.grade` required (`@default(FIRST_SECONDARY)`), registration already validated | `prisma/schema.prisma` + migration `20260905000000_require_user_grade` |
| 2.1 | `BunnyVideo.position` + `PUT /courses/:courseId/reorder` (ADMIN) | `prisma/schema.prisma` + migration `20260905010000_bunny_video_position`, `bunnyVideoService.js`, `bunnyVideoController.js`, `bunnyVideoRoutes.js`, `quizService.js`, `videoProgressController.js` |
| 2.2 | `Quiz.maxAttempts` (default 3), 409 once exhausted, EXPIRED attempts don't burn a retake | `prisma/schema.prisma` + migration `20260905020000_quiz_max_attempts`, `quizService.js`, `quizController.js`, `quizConfig.js` |
| 2.4 | README rewritten to match current stack | `README.md` |
| 3.1 | `scripts/testImports.js` removed | deleted |
| 3.2 | `getCookieConfig()` removed from `src/utils.js` | `src/utils.js` |
| 3.3 | Empty placeholders removed: `src/routes/videoProcessing.js`, `src/controllers/videoProcessingController.js`, `src/middlewares.js` | deleted |

**Applied**: The three schema migrations above were applied by the user (`prisma migrate status` reports up to date, 24/24) and the Prisma client is in sync. Frontend commits for that round: `e5d825a` (types/QuizIntroCard, maxAttempts + position).

## Security round 1 (Sept 2026) — cookie-only auth + CRITICAL fixes

Sealed plan: `plans/security-round1.md`. All changes paired backend ↔ frontend.

### Auth model (BREAKING for clients)

- **Cookie-only**: login/register/refresh NEVER return `token`/`refreshToken` in the body — only HttpOnly cookies (`accessToken` 15min, `refreshToken` 7d, path `/auth`).
- **Dedicated refresh secret**: `REFRESH_TOKEN_SECRET` in `.env` (real value set locally; `.env` is gitignored). `src/config/env.js` resolves it, refuses to start in production on a placeholder, and warns + falls back to `JWTSECRET` in dev.
- **`type` claims**: access tokens carry `{ type: 'access' }`, refresh tokens `{ type: 'refresh' }`. `authenticateToken` rejects anything not `type:'access'`; the refresh endpoint rejects non-refresh tokens.
- **Rotation**: `/auth/refresh-token` issues a new refresh token, persists it to DB, re-sets the refresh cookie. The old token dies immediately. Refresh tokens include a `jti` nonce (`createRefreshToken`), so rotation can never produce a byte-identical token within the same second.
- **Legacy**: tokens issued before this change (no `type`) are rejected → clients get one forced re-login. Frontend `authService` sets `isLoggedIn` from a successful `/user/me`, not from a body token. `lib/api-client.ts` keeps the in-memory Bearer store as a compat shim but never populates it.
- **Scripts**: `scripts/uploadDemoVideos.js` authenticates by extracting `set-cookie` cookies (no bearer token). Login-response consumers inside a cookie-less client are broken by design.
- **Session-preserving `register`** (`ef97dd8`): `POST /auth/register` runs `optionalAuth` first and sets login cookies ONLY when the caller has no session. Registering from an authenticated context (e.g. the admin console's add-student dialog, which reuses this public endpoint) no longer overwrites the caller's `accessToken`/`refreshToken` — previously the admin's session was silently replaced with the new student's, breaking every subsequent admin call with 403.

### Fixes in this round

| Finding | Fix | Where |
|---------|-----|-------|
| #1 refresh secret placeholder | real `REFRESH_TOKEN_SECRET` + claims + rotation | `env.js`, `utils.js`, `authController.js`, `middlewares/index.js` |
| #3 answer-key leak | `getAssignment` strips `correctOption`/`explanation` for students pre-submission (admins/post-submit see full) | `src/controllers/assignmentController.js` |
| #4 progress trusts client | `markVideoCompleted` requires the video to be the current unlocked index (first, or previous completed) → 403 `VIDEO_NOT_UNLOCKED` | `src/controllers/videoProgressController.js` |
| #10 brittle gate 403 | structured `code`s: `NOT_ENROLLED`, `SEQUENTIAL_GATE`, `ASSIGNMENT_REQUIRED/PENDING/REJECTED`, `VIDEO_NOT_UNLOCKED`, `VIDEO_NOT_FOUND` | `sequentialAccess.js`, `bunnySequentialAccess.js`, `videoProgressController.js` |
| #2 admin routes unguarded (FE) | `app/admin/layout.tsx` role-guards all `/admin/**` (non-ADMIN → redirect) | FE |
| Assignments FE-only hide | dispatch wiring for assignments removed (`course/[id]/page.tsx` + `video/[video]/page.tsx`), profile link removed | FE — **🔶 the two `app/course/[id]/*` edits are UNCOMMITTED, riding inside the user's WIP working tree**; `me/user/page.tsx` + guard committed |

**Committed on backend `Dev`**: `ea97a4c` (auth BE), `eee12cb` (#3), `b100650` (#4 + codes), plan file in `ea97a4c`. **Frontend `Dev`**: `3b6a1fe` (auth pairing), `44932ce` (admin guard), `dad5a86` (profile link).

### Essay grading — deliberately unchanged

Passing a quiz with an essay still **requires an admin-graded essay** (score% uses `mcqEarned/(mcq+essay)`). A perfect MCQ score alone can be blocked pending grading. Accepted behavior until an AI-grader is built (user decision).

### Frontend agent coordination

The FE agent's shared brain lives at **`<frontend>\plans\frontend-handoff.md`** (committed `2048d35`) — read it, and keep it updated, whenever backend behavior changes that the FE depends on (auth, error codes, endpoints).

## Admin console (Phase 3, Sept 2026)

Delivered under `plans/admin-dashboard-plan.md` (P0–P3 done; P4 optional). Admin UI repo = **`L:\E-LRN-FRONTEND\a-e-lrn-frontend`** (`app/admin/**`, `components/admin/**`, `services/admin*.ts`), dark design system scoped under `.admin-console`.

- **Admin-only API surface** (all behind `authenticateToken, authorizeAdmin()`): `src/routes/adminRoutes.js` mounts `/admin/dashboard`, `/admin/quizzes`, `/admin/attempts`, `/admin/enrollments` (GET/POST), `/admin/enrollments/:id` (DELETE). Other admin-only routes live in their home route files (users list/get/delete, courses CRUD, bunny video create/reorder/upload/delete, quiz upsert/delete/attempts/grade/reset/exemptions).
- **Leak rule:** `/admin/quizzes`, `/admin/attempts`, and `/admin/enrollments` serializers never include `answerKey`, `answers`, `password`, or `refreshToken`.
- **Enrollment semantics:** admin-enroll is auto-paid `isPaid: true` (payment disabled); duplicate `{userId, courseId}` → 409; unenroll is a hard FK-safe DELETE.
- **User edit:** `PUT /user/:userId` as ADMIN may also set `grade` + `phoneNumber`; self-edit stays name/email/password.
- **Search:** `GET /admin/quizzes?search=`, `/admin/attempts?status=&search=`, `/admin/enrollments?search=` (student/course); `GET /user?role=&grade=&search=&sort=`; `GET /courses?search=`.
- **Deferred (no console UI, per user decision, Q1):** legacy `Video` URL CRUD, assignments admin, certificates, admin role editing (P4.4). Docs: FE `frontend-handoff.md` §99.3/99.4.
- Demo seed: `scripts/seedDemoQuizzes.js` — course #8 videos 4/5/9; `grader-demo@localhost.test` / `GraderDemo#2026` has a **GRADING essay attempt** for inbox testing (attempt #87 was consumed during P3 checkpoint verification — re-run the seed to re-arm the inbox); `seqaccess@localhost.test` has pre-passed gates.

### Out of scope (deferred)

CSP/security headers (#7), `/courses/enrolled` response shape (#9), paywall stays free, admin site work beyond the layout guard.

## Admin console review round (Sept 2026) — committed `1cf94e2` (BE) + `f3664d9` (FE)

Multi-axis review (both repos) of the P3 diff. Required findings fixed and verified:

| Finding | Fix |
|---------|-----|
| Enrollment dedupe TOCTOU | `@@unique([userId, courseId])` on `Enrollment` (migration `20260907000000_enrollment_unique_user_course`); both `adminEnroll` and legacy `enrollUserInCourse` catch P2002 → 409 as a race backstop (pre-check kept for UX). Data verified duplicate-free before applying. |
| `limit`/`take` no lower clamp | `take = Math.max(1, Math.min(limit‖20, 100))` on `GET /admin/enrollments`, `/admin/quizzes`, `/admin/attempts`, `GET /user`. |
| NaN `:userId` in PUT/DELETE `/user/:id` | 400 `Invalid user ID.` on non-safe-int ≤ 0. |
| Duplicate email/phone on admin user-edit | P2002 → 409 `Email or phone number already in use.` (was generic 500). |
| FE `applySearch` kept stale `page` | `setPage(1)` inside `applySearch` on grading/quizzes/enrollments/students/courses; refresh also clamps `page` to `totalPages`. |

Deferred (Optional, low-risk, no UI impact): FE `loadCourseRows` staleness race, reset-button busy flag during in-flight grade, stale `result` on failed `openAttempt`, dropdown `limit:100` cap, duplicated `GRADES` arrays, `parsePositiveInt('1abc')` leniency. Pre-existing unrelated: home-page images (`teacher.png`, `grade1–3.png`, `brain.png`) missing from `public/` → 400s on `/`.
