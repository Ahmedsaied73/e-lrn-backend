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
- **Payments module SHIPPED (2026-09-19)** — all T0–T8 committed on `Dev` and pushed to `Dev` + `master` (backend HEAD `6f2c399`, frontend HEAD `05ae4ee`). Live sandbox intention verified end-to-end; full E2E 24/24; suite 38/38. See `plans/payments-plan.md` (gitignored, local).
- **USER ACTION required for production enable:** follow `plans/prod-config-checklist.md` §5b (full go-live procedure: migrations → live PAYMOB_* creds → `PUBLIC_API_URL` + `FRONTEND_URL` → T9 sandbox purchase → flip `PAYMENTS_ENABLED=true` last). Test keys are currently in local `.env` only; run `prisma migrate deploy` on production (the two payments migrations apply cleanly — the RLS lockdown migration is already recorded).
- T9 deferred by user request: no live sandbox PURCHASE was run (only a test intention + full forged-callback E2E). A manual real-sandbox purchase with a test card is the last acceptance step before flipping prod on.
- Stale temp artifacts (`boot-*.txt`, `t3-*`, `e2e-server.txt`) are untracked and locked by other processes — safe to delete after those processes exit.
- Load-test cohort cleanup (`%loadtest.local` users) on staging — awaits user sign-off.
- **P2 hardening plan COMPLETE (2026-09-19)** — all 5 tasks delivered on `Dev`: `plans/p2-hardening-plan.md`. Commits: 08abacf+b2fcb89 (/metrics), 640e88b+88d4742+5830578 (uptime probe + docs), 92db23b (login semaphore + threadpool), 8d63dc4 (RLS lockdown, applied to staging), ae235bf (3 test suites). `npm test` 25/25, lint clean.
- USER ACTION required to activate Task 5: add `PROD_BASE_URL` repo secret, push `Dev`, trigger `uptime-probe` once via workflow_dispatch. Restart the local dev server (3005) to expose `/metrics`.
- USER ACTION: production must run the RLS migration (`prisma migrate deploy`, or the documented `db execute` + `migrate resolve --applied` procedure) at deploy time.
- Deferred (documented, non-blocking): `/metrics` auth token option; AGENTS.md note that public.* is RLS default-deny (zero policies); `tests/` not covered by `npm run lint` (script is `eslint src app.js`); cold-cache gate tail + dashboard 16-query fanout.
- Housekeeping: one locked temp file `anon-probe.txt` could not be deleted (held by another process) — untracked, safe to remove after that process exits.
- PAYMOB WIP (not ours, untouched): `prisma/schema.prisma`, `.env.example`, `src/config/env.js`, `app.js` working diff, payment/enrollment/notification controllers, `src/controllers/paymobWebhookController.js`, `src/integrations/paymob/`, `src/services/paymentService.js`, `tests/paymob.test.js`, `prisma/migrations/20260919120000_paymob_payments/` (migration deliberately left UNAPPLIED), `test-out.txt`.
- Load-test cohort cleanup (`%loadtest.local` users) on staging — awaits user sign-off (tasks/db-audit-todo.md last checkbox).
