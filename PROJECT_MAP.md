# PROJECT_MAP

## [TECH_STACK]
- Node.js (v24 CI) + Express 4, CommonJS. Port 3005. Run: `npm run dev`; tests: `npm test` (self-hosts on 3106, needs `.env` + demo fixtures); lint: `npm run lint` (ESLint 9 flat).
- Postgres on Supabase via Prisma ORM. Pool: `src/config/db.js` (connection_limit default 20, env `DATABASE_CONNECTION_LIMIT`, cap 50; pool_timeout 20s). Migrations via session pooler `DIRECT_URL:5432`; app uses transaction pooler `:6543?pgbouncer=true`.
- Redis: rate-limit store (fail-open w/ in-memory fallback), account lockout, gate cache `v1:gate:{userId}:{videoId}` TTL 300s.
- Auth: cookie-only JWT (access 15m / refresh 7d, separate `REFRESH_TOKEN_SECRET`, type claims, rotation with jti). bcrypt v5.
- Integrations: Bunny Stream (`src/integrations/bunny/bunnyStreamClient.js`, circuit breaker), Sentry (DSN-gated), BullMQ AI-grader (optional module), Supabase Storage (uploads).
- Health probes: `/health` (DB), `/healthz` (liveness), `/readyz` (readiness).

## [SYSTEM_FLOW]
1. **Student learn flow:** login → course list (`/courses`) → course detail (slug) → video playback (`/videos/:videoSlug/playback`, gate-checked) → progress POST (`/progress`) → quiz submit (`/quizzes`) → gate re-eval → next video unlock.
2. **Auth flow:** register/login → HttpOnly cookies only (never body tokens) → `/auth/refresh-token` rotation (old token dies) → 423 lockout after 5 consecutive failures.
3. **Admin flow:** admin console (`/admin/**`, role re-checked in DB w/ TTL cache) → CRUD courses/videos/quizzes → enroll (auto-paid, 409 dup) → grade essays → broadcast notifications.
4. **Video pipeline:** upload (Busboy→Bunny) → PENDING→UPLOADING→PROCESSING→READY (webhook `/webhooks/bunny/stream`, HMAC-verified, mounted before express.json) → reconcile job (10 min) for stuck PROCESSING.
5. **Sequential gate:** `evaluateGate` in `src/services/quizService.js` = single source of truth; Redis-cached (300s), invalidated on every gate-state write; admins bypass.

## [ARCHITECTURE]
- `app.js` — entry; middleware order: trust proxy → CORS/origin-403 → CSRF → helmet(CSP) → webhook(raw) → json → limiters → routes → probes → global error handler. Crash-safe async patch loaded first.
- `src/routes/` + `src/controllers/` + `src/services/` (business logic) + `src/middlewares/` (auth/role/sequential/csrf/logger) + `src/config/` (env fail-fast, db, cors single-source) + `src/integrations/` (bunny, redis) + `src/jobs/` + `src/utils/` (slugs, AppError).
- Tests: `tests/*.test.js` via `scripts/run-tests.js` (spawns server, waits `/health`, net-zero against staging DB).
- CI: `.github/workflows/ci.yml` (Redis service, lint + suite + prisma validate/status).
- Plans: `plans/*.md`. Audit record: `tasks/db-audit-*.md`.

## [ORPHANS & PENDING]
- P2 hardening plan `plans/p2-hardening-plan.md` — Tasks 2 + 5 DONE & approved. PAUSED by user 2026-09-19: Tasks 1 (login burst), 3 (RLS lockdown), 4 (test coverage) remain. [PAUSED]
- USER ACTION owed (from Task 5): restart dev server on 3005 (predates `/metrics`); add `PROD_BASE_URL` repo secret; push; trigger `uptime-probe` once via workflow_dispatch.
- USER-SIDE DEFERRED: paymob payments WIP in working tree (uncommitted, unrelated to this plan — user said ignore for now; note Task 1 will touch app.js which paymob WIP also touches — needs hunk-scoped staging when resumed).
- Deferred minors (reviewer, Task 2): optional METRICS_TOKEN/IP allowlist on `/metrics`; resetMetrics test export; count client-aborted requests.
- Load-test cohort cleanup (`%loadtest.local` users) on staging — awaits user sign-off (tasks/db-audit-todo.md last checkbox).
- Optional: hosted Prometheus/Grafana scraping of `/metrics` (endpoint live as of Task 2); cold-cache gate tail + dashboard 16-query fanout (deferred, documented in audit).
