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
- **`BunnyVideo` has no `position` field** — ordering is by `createdAt` only, no reorder API.

## Bugs confirmed by grilling (fix priority)

### Critical (fix immediately)
1. **`previousVideo` undefined** — `sequentialAccess.js:76` references `previousVideo` but `evaluateGate` returns `previousVideoId`. Throws `ReferenceError`. Never tested.
2. **`evaluateGate` only queries `BunnyVideo`** — legacy Video courses completely locked for students. `evaluateGate` does `prisma.bunnyVideo.findUnique({ where: { id: videoId } })` — a legacy Video ID won't be found.
3. **`deleteCourse` doesn't clean up Bunny remote** — deletes DB rows but never calls `bunnyClient.deleteVideo()`. Orphaned videos cost money.
4. **`submitAttempt` ternary is dead code** — both branches identical (`mcqEarned`), essay score always 0 at submission.

### Schema/Design (fix before launch)
5. No `position` on `BunnyVideo` — needs migration + reorder API.
6. Quiz retake logic undefined — no max attempts, no retake flow.
7. `User.grade` optional but required for recommendations — students without grade get nothing.
8. README completely stale — wrong roles, wrong quiz model, outdated instructions.

### Dead code (clean up)
9. `testImports.js` — references nonexistent `youtubeRoutes`. Remove.
10. `getCookieConfig()` in `src/utils.js` — never imported. Remove.
11. `videoProcessing.js` / `videoProcessingController.js` — empty placeholders. Review before removing.
