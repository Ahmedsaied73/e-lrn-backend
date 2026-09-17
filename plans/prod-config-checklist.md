# Production Configuration Checklist — pre go-live

Inspect every item and tick it before the first production deploy. Pair this with
`src/config/env.js` + `.env.example` (single source of truth for every var).
Nothing here should be optional guessing — each item is either verified-good or a
blocker.

---

## 1. Env var audit (`.env` on the prod host, never committed)

- [ ] `NODE_ENV=production` — makes cookies `Secure`, enables strict CORS, kills
      payment + AI grader/fixture behavior. Correct even if Docker sets it again.
- [ ] `PORT=3005` — used by Railway/Render healthcheck and Docker EXPOSE. If you
      change it, update the Dockerfile `EXPOSE` + compose mapping too.
- [ ] `DATABASE_URL` — **pooled** (transaction pooler): `[ref].pooler.supabase.com:6543?pgbouncer=true&sslmode=require`. The app MUST use the pooler (IPv6-only direct host is unreachable from IPv4-only networks — Prisma P1001).
- [ ] `DIRECT_URL` — **session pooler** `[ref].supabase.co:5432?sslmode=require` for `npm run db:setup` (migrations). Two DIFFERENT hosts by design — don't copy one into both.
- [ ] `JWTSECRET` + `REFRESH_TOKEN_SECRET` — long random strings, **different from each other** (refresh tokens are signed with a dedicated secret; access tokens get `type:'access'`, refresh `type:'refresh'`). Refuses prod boot on a placeholder value.
- [ ] `JWT_EXPIRY=15m` and access cookie `maxAge` 15min are in sync (T5.2). `REFRESH_TOKEN_EXPIRY=7d` + refresh cookie 7d in sync. Verify `src/config/cookie.js` still matches.
- [ ] `ADMIN_EMAIL` + `ADMIN_PASSWORD` — strong admin password; auto-seeded on boot by `src/config/setupAdmin.js`. Never reuse the dev default.
- [ ] `FRONTEND_URL` — exact FE origin (comma-separated if multiple). Both CORS **and** CSRF origin allowlist read it (`src/config/cors.js`). Add the Vercel wildcard only if you accept ANY `*.vercel.app` preview (default allows it).
- [ ] `COOKIE_SAMESITE` — leave unset in prod → defaults to `none` + `Secure` (cross-site FE↔API). If you ever serve FE + API same-site, set `lax`.
- [ ] `TRUST_PROXY=1` — REQUIRED so `req.ip` is the real client (rate limiters + lockout key by IP). Verify the healthcheck/proxy is exactly ONE hop.
- [ ] `REDIS_URL` (TCP `rediss://`, **not** the HTTPS REST endpoint — ioredis/BullMQ need TCP) + `REDIS_ENABLED=true`.
- [ ] `REQUIRE_REDIS_RATE_LIMIT` — **recommend `true` in prod** (fail-closed 503) since the API is internet-exposed. If `true`, REDIS must really exist (fatal at boot otherwise). If left `false`, remember the degraded mode below.
- [ ] `LOGIN_FAILURE_THRESHOLD` / `ACCOUNT_LOCKOUT_MS` — confirm prod values (defaults 5 / 15min).
- [ ] Bunny: `BUNNY_STREAM_LIBRARY_ID`, `BUNNY_STREAM_API_KEY`, `BUNNY_STREAM_READ_ONLY_API_KEY`, `BUNNY_STREAM_TOKEN_KEY`, `BUNNY_VIDEO_MAX_BYTES`. Confirm **"Embed View Token Authentication" is ON** in the Bunny library Security tab (else signed playback is not enforced).
- [ ] Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_QUIZ_BUCKET` (`quiz-images`, public). Service key never leaves the server — image uploads proxy via `POST /quizzes/images`.
- [ ] AI Grader: `GEMINI_API_KEY` + `AI_GRADER_*` — or leave unset (essays then wait in the human inbox). `AI_GRADER_ENABLED=true` with no key = silent off + warning; confirm that's intended.
- [ ] `NOTIFICATIONS_ENABLED` / `AI_GRADER_ENABLED` — deliberate, since modules are pure building blocks (unmount vs skip semantics).

## 2. DB / migrations

- [ ] Run `npm run db:setup` (`prisma migrate deploy && prisma generate`) on prod. All 24 migrations applied; `prisma migrate status` clean.
- [ ] Confirm `AuditLog` migration applied (`20260917000000_audit_log`).
- [ ] Take a **Supabase backup/snapshot** before anything destructive; verify a restore path exists.
- [ ] Idempotent seed scripts only (`scripts/seedDemoQuizzes.js` re-runs safe). No dev demo accounts in prod data.

## 3. Rate limiting & lockout — post-deploy behavioral check

- [ ] **Fail-closed** (`REQUIRE_REDIS_RATE_LIMIT=true`): kill Redis temporarily (or stop the service) → API returns `503 RATE_LIMIT_STORE_UNAVAILABLE`, not an unthrottled pass-through, not a 500. Restart Redis → recovers.
- [ ] **Fail-open-with-fallback** (if you chose `false`): kill Redis → login still trips the **per-instance** counter (429 after budget) because the store falls back to an in-memory counter.
- [ ] ⚠️ **Documented degraded mode**: the in-memory fallback is **per instance, not shared**. During a Redis outage, the effective threshold is "N requests per instance", not global. With a single instance that's identical; with N instances an attacker gets N× the budget. Explicitly accepted for now (see `rateLimitStore.js` header + AGENTS.md).
- [ ] Login lockout smoke: 5 wrong passwords → `423 ACCOUNT_LOCKED` + `Retry-After`, clears on success.

## 4. Auth & cookies — cross-site smoke (do this in a real browser)

- [ ] Login from the FE origin → `accessToken` cookie (Secure) set, 15min; `refreshToken` cookie (Secure, path `/auth`) set, 7d. NO tokens in the response body (cookie-only).
- [ ] Page refresh at ~16min → refresh flow rotates the refresh token silently (no forced re-login), old refresh token invalidated.
- [ ] CORS: FE origin succeeds; a random/evil `Origin` on GET, POST, and preflight → `403 ORIGIN_NOT_ALLOWED` (not 500).
- [ ] No-Origin clients (curl, server-to-server) still work; webhook POST has no Origin → allowed.
- [ ] `OPTIONS` preflight to an allowed origin returns CORS headers (not 403).

## 5. Webhooks & Bunny

- [ ] `POST /webhooks/bunny/stream` still 200 with a valid HMAC-signed payload; 401 without the signature. Rate limiter (600/5min/IP) sits in front, never breaks raw-body/HMAC.
- [ ] Video upload → PROCESSING → READY flow works end-to-end; FAILED allows re-upload.

## 6. Security headers & top-level checks

- [ ] Helmet on (HSTS enabled by default) — CSP intentionally OFF (would need FE coordination).
- [ ] Admin surfaces all behind `authenticateToken` + `authorizeAdmin()`; `/admin/quizzes|attempts|enrollments` serializers leak no `answerKey`/`answers`/`password`/`refreshToken`.
- [ ] `POST /auth/login` under the global limiter (1000/15min) AND the per-route login limiter (20/15min).

## 7. Ops / runtime

- [ ] `uploads/` volume mounted (docker-compose does) — assignment submissions persist across redeploys.
- [ ] Pre-go-live: run the uploads migration script (`scripts/migrateUploadsToSupabase.js`) against real prod data ONLY at this moment — scratch-bucket tested already, never run against prod before now. Verify every file landing, then move `uploads/` to read-only.
- [ ] Logs: structured JSON one-liners `[RESPONSE]`/`[ERROR]` include requestId — check the aggregator (Railway/Render/…) doesn't strip it. `/health` + `/metrics` excluded from request logs by design.
- [ ] Background job: reconcile-stale-videos running (polls Bunny every 10min). AI grader worker boots with Redis + BullMQ.

## 8. Sign-off

- [ ] `npm test` (4/4) green against the prod-adjacent staging env.
- [ ] Browser check of the full student path: enroll → watch 1st video → pass quiz → unlock next video → assignment submit (if enabled).
- [ ] Admin console paths smoke: dashboard, quizzes, attempts grading, enrollments, users.