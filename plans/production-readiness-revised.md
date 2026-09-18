# Production-Readiness — Revised Plan (gaps only, no leftover work)

Status: **GRILLED — decisions locked, awaiting execution order.**
Author: reviewed `implementation_plan.md` (85+ scoreline plan) against the actual `Dev` tip (`a4aac4f`, backend) and `L:\E-LRN-FRONTEND\a-e-lrn-frontend` on Sep 18 2026.

## Grilled decisions (Sep 18 2026 — user)

| Q | Decision |
|---|----------|
| G1 | Prod reachable. **Push `Dev` to `origin` FIRST** (prerequisite, before any work), then execute the plan. |
| G2 | `/readyz` gates on **DB only** (Redis is fail-open by design; a Redis-less readiness matches it). |
| G3 | **Backend-only Sentry** (`@sentry/node`, DSN from env, hook `app.js:265` + AppError path). FE stays on PostHog. |
| G4 | FE CI = **lint + build + the 2 existing Playwright e2e smoke** (`e2e/login-credentials-never-in-url.js`, `e2e/register-credentials-never-in-url.js`). **No Vitest this round.** |
| G5 | F-3: **local `next build` verify first**, then wire into CI. |
| G6 | **Ship `achievements` as-is.** No dashboard build task. |

## Prerequisite (do before everything)

- [ ] **Push**: `git push origin Dev` on `H:\e-learning-platform` (repo is 63 commits ahead; prod env vars assumed reachable/present).

## What the original plan got wrong (verified)

The original 85+ plan is built on **stale snapshots and fabricated premises**. Its "score" (70 → 87.3) has no baseline and no measurement — it is decoration, dropped here.

| # | Original task | Reality (verified on disk) | Verdict |
|---|---------------|----------------------------|---------|
| 3.1 | "Add Redis catalog cache, `redis.del('cache:/courses*')`" | `src/integrations/redis/cache.js` **already exists** (get/set/del/**delPrefix**/withCache/single-flight/256KB cap) and is **wired into coursesController** (list cache, 90s TTL, `delPrefix('v1:courses:')` on create/update/delete), quizController, quizService gates, bunnyVideoService. Also `redis.del` with a wildcard **is not valid Redis** — the codebase correctly uses SCAN-based `delPrefix`. | **Delete task** — done + architecture better than planned |
| 3.2 | "Create standalone AI-grader worker" | `scripts/ai-grader-worker.js` + `npm run worker:ai` + `src/services/aiGrader/worker.js` (`startAiGradingWorker`/`stopAiGradingWorker`/`processGradingJob`/`checkBudget`) **all exist** (Layer 0+1). | **Delete task** — done |
| 2.1/2.2 | "Build single-query dashboard aggregate; FE dashboard does N× fetchCourseById" | `GET /user/me/achievements` (`achievementsController.js`) **already aggregates** enrollments + per-course progress + quiz best scores in ~3 parallel queries. FE `/me/user` calls `getAchievements()` once — **not** N per-course calls. | **Delete build task.** Max residual: extend `achievements` shape if a specific field is missing (decide in grill Q) |
| 1.2 | "Add Sentry to `src/middlewares/errorHandler.js`" | **File does not exist.** Global handler is inline in `app.js:265`. | **Retarget**, not destroy — real gap (no error tracking anywhere) |
| 4.2 | "Hermetic supertest in-process tests, export app" | `app.js:313` calls `app.listen` directly; no app export. Existing `scripts/run-tests.js` self-hosts on TEST_PORT 3106 (spawns `app.js`, waits `/health`). Tests need staging Supabase + Redis + fixtures — **not hermetic regardless**. Rewriting = regression risk for zero gain. | **Delete task** |
| 4.3 backend | "Create backend CI" | `.github/workflows/ci.yml` **already exists** (lint → `npm test` with Redis service → prisma validate/migrate status). | **Delete backend part**; keep FE part (below) |
| 5.2 | "Remove external Google Fonts link, self-host Cairo" | Fonts are **already self-hosted** (`next/font/local`, Tajawal woff2 400/500/700/800, arabic+latin). No Google Fonts `<link>` at all. Cairo swap is a **design preference**, not a perf gap. | **Delete task** (or fold into design-taste question) |
| 5.3 | "Migrate raw `<img>` → next/image (dozens)" | Exactly **3** raw `<img>` tags in all of `app/` + `components/`. `next.config.js` already has `remotePatterns` allowlist + security headers. Missing `sharp` for prod optimization. | **Shrink to a small task (<1h)** |
| scoreline | Composite 70 → 87.3 | No data source exists. | **Remove** |

## What is genuinely still missing (the real plan)

### Backend (`H:\e-learning-platform`)

**B-1. Liveness vs readiness probes.** Today there is one `/health` (`app.js:190`) that DB-pings only. Docker/Railway want a dead-simple liveness (process up) and a readiness that reflects real dependency health.
- Keep `/health` untouched (harness + CI depend on it).
- Add `/healthz`: process alive, no I/O, fixed 200.
- Add `/readyz`: **DB ping only** (decision G2 — Redis fail-open by design, never gates readiness; the process never kills itself on degradation).
- Files: `app.js`, `src/routes/healthRoutes.js` (new).
- Verify: curl all three endpoints; `npm test` still green (harness waits `/health`).

**B-2. Backend error tracking.** Decision G3: **Backend-only Sentry**.
- Add `@sentry/node`; init in `app.js` when `SENTRY_DSN` is present (no-op otherwise); hook the global handler at `app.js:265` and the AppError path; add `SENTRY_DSN` to `src/config/env.js` + `.env.example`.
- Frontend stays on PostHog — no `@sentry/nextjs`.
- Files: `app.js`, `src/config/env.js`, `.env.example`, `package.json`.

### Frontend (`L:\E-LRN-FRONTEND\a-e-lrn-frontend`)

**F-1. Frontend CI — genuinely missing.** No `.github/workflows/ci.yml`, no test script at all.
- Add workflow: checkout → `npm ci` → `next lint` → `next build` → **run the 2 existing Playwright e2e smokes** (decision G4 — no Vitest).
- The 2 e2e scripts (`e2e/login-credentials-never-in-url.js`, `e2e/register-credentials-never-in-url.js`) test real behavior; they need the app booted (via `npm run build && npm start`, or `dev`) and a backend reachable — CI must decide the backend URL (staging `TEST_BASE_URL`-style or skip on missing secrets). If backend secrets aren't available in the FE repo's CI, run the smokes against a required `CI_TEST_BACKEND_URL` var and skip (exit 0, annotated) when absent.
- Files: `.github/workflows/ci.yml` (new), `package.json` script alignment, `e2e/*.js` runner tweaks only if needed.

**F-2. Unit-test baseline — CANCELLED by grill decision G4.** The two Playwright e2e smokes are the regression net this round. `devDependencies` stays empty until a Playwright failure actually demands unit tests. No Vitest, no `vitest.config.mts`.

**F-3. Dependency hygiene — real and correct.** All 70 packages including `typescript`, `tailwind`, `postcss`, `eslint` sit in `dependencies` because `devDependencies` is empty. Move build-time tooling to `devDependencies`; pin `engines` (currently empty).
- **Local verify first, then CI** (decision G5): run `npm run build` locally after the move; only wire the CI job after it's green locally. On a red `next build`, revert the move immediately.
- Risk: Tailwind v4.3.3 + Next 13.5 + PostCSS plugin wiring — verify `next build` after the move.
- Files: `package.json`, `package-lock.json`.

**F-4. `next/image` + `sharp`.** Migrate exactly 3 raw `<img>` tags and add `sharp` so remote optimization actually works in production (`next start`). `remotePatterns` already allowlist `**.b-cdn.net`, ytimg, etc. — no config security work needed.
- Files: 3 components, `package.json`.

## Explicitly NOT in this plan

- Redis cache (exists), AI worker (exists), dashboard aggregate (exists as `/user/me/achievements`), backend CI (exists), font self-hosting (exists), supertest rewrite (regression risk), multi-agent parallel topologies for a <10-task plan.
- Progression/UX changes (agreed out of scope), assignments admin, certificates, legacy `Video` CRUD (already deferred Q1).

## Execution model

Sequential on `Dev`: **(0) push prerequisite →** B-1 → B-2 → F-1 → F-3 → F-4 — F-2 is cancelled. No parallel branches. Two checkpoints: backend done (run `npm test` + lint + curl the three probes) and frontend done (`next build` locally first, then CI job green).

## Risks & mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `/health` semantics change breaks the test harness/CI | High | `/health` untouched; `/healthz`/`/readyz` added alongside. Harness unchanged. |
| Moving FE deps to `devDependencies` breaks `next build` | Med | **Local build first** (G5); revert the move on red before touching CI. |
| Sentry adds vendor surface | Med | Backend-only (G3), DSN-gated no-op, AppError + global handler only. |
| FE CI e2e smokes need a backend | Med | Gate on `CI_TEST_BACKEND_URL` (or secrets); skip-with-annotation when absent. |
| 63-commit gap untrackable | High | Push prerequisite is step 0, executed before any code change. |

## Open questions (all resolved Sep 18 2026 — see table at top)

1. ~~Backend error tracking — Sentry or log-sink?~~ → **Backend-only Sentry (G3)**
2. ~~Lock engines/node on both repos?~~ → **F-3 includes `engines`; exact version decided at execution**
3. ~~FE test baseline — Vitest, Playwright, or lint+build?~~ → **CI lint+build + 2 existing Playwright smokes (G4)**
4. ~~Extend /user/me/achievements?~~ → **Ship as-is (G6)**
5. ~~Cairo font swap?~~ → **Not in scope: fonts already self-hosted, design preference only**
6. ~~CI deploy previews?~~ → **CI-only, no preview deploys**