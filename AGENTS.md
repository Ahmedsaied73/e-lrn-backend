# AGENTS.md

## Project

Node.js/Express e-learning platform for Egyptian secondary school students. Courses contain videos (Bunny.net Stream), quizzes (SurveyJS), and assignments. Students progress sequentially. Admins manage everything.

**Stack**: Express, MySQL 8.0 (Prisma ORM), Bunny.net Stream, JWT cookies, Busboy. Port **3005**.

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
prisma/schema.prisma    → Single schema, MySQL
```

## Key conventions

- **Module system**: CommonJS (`require`/`module.exports`), not ESM.
- **Env**: `.env` loaded via `dotenv` (referenced in `.env.example`). Never commit `.env`.
- **Auth**: JWT stored in httpOnly cookies (`accessToken` or `token`). `authenticateToken` middleware checks cookie first, then `Authorization: Bearer` header.
- **Error handling**: Bunny service layer uses `AppError` from `src/utils/AppError.js` → global handler in `app.js:128` returns `{ success: false, error, code }`. Quiz service uses ad-hoc `Object.assign(new Error(...), { statusCode })`. Legacy routes use raw `res.status().json()`.
- **Bunny webhook**: Mounted at `/webhooks/bunny/stream` *before* `express.json()` in `app.js:68` — it needs raw body for HMAC verification. Do not reorder.
- **Rate limiting**: 100 req/15min global, 20 req/15min on `/auth/login`.
- **CORS**: Allowlisted origins only (localhost:3000, localhost:3002, `FRONTEND_URL`).
- **Database**: MySQL 8.0. Prisma schema uses `Autoincrement()` IDs. Run `npm run db:setup` after schema changes.
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

### Out of scope (deferred)

CSP/security headers (#7), `/courses/enrolled` response shape (#9), paywall stays free, admin site work beyond the layout guard.
