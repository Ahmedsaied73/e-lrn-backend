# DB Audit — Phase 2 Load Test Report (STAGING)

Date: 2026-09-14 · Staging project: `ltageakmwodqsyfcoxjh` (aws-1-eu-west-1)
Target: locally-running Express (port 3005/3006) against staging Supabase pooler + Upstash Redis

## Summary

The approved k6 load scenarios were executed against the staging environment. **Both scenarios failed catastrophically at realistic student concurrency, blocked by the app's Prisma connection pool, not the database.** 200 concurrent students with a bare `PrismaClient()` pool of 9 connections → 10s pool-timeout 500s en masse; the database itself sat idle (16 idle / 1 active). No schema, code, or config changes were left in place; the synthetic 500-student cohort is intact awaiting cleanup.

**Bottom line: the API cannot serve its own target load (500-student concurrent session herd) until the application-level connection pool and the query-per-request count are fixed. This is a P0 for launch, independent of any DB-side tuning.**

## Scenarios & results

### Phase 2a — playback + dashboard (pre-generated JWTs, no login)

- 200 VUs × 2000 shared iterations `GET /videos/1/playback` (auth via `Authorization: Bearer <pregen JWT>`) + 3 VUs constant-3min `GET /admin/dashboard` polling.
- `LOAD_TEST=true` temporary override raised the global IP + login rate limits on a **sibling instance on port 3006** (port 3005 untouched). Ratelimits reverted & Redis buckets flushed afterward.

| Metric | Playback | Dashboard | Note |
|---|---|---|---|
| Requests | 1532/2000 (468 dropped) | 27 | playback_fetch capped at its 5m4s iteration window |
| Success rate | 85.4% (1309) | 29.6% (8) | failures = HTTP 500, P2024 pool timeout |
| Median | 46.3 s | 18.9 s | vs ~87.7 ms isolated smoke baseline |
| p(95) | 48.7 s | 19.9 s | |
| thresholds | ✗ rate>0.95, p(95)<2000 | ✗ | |

### Phase 2b — login herd (500 concurrent students)

- 500 VUs × shared iterations: `POST /auth/login` + `GET /user/me`, distinct synthetic users, on the same 3006 load instance. Finished in 24.7 s.

| Metric | Login | /user/me |
|---|---|---|
| Success rate | 42.2% (211/500) | 74.4% (157/211) |
| Median | 11.99 s | 8.89 s |
| p(95) | 18.4 s | 10.1 s |
| Expected-response med | — | (of those that logged in) |

Overall request failure rate: **48.2%** (343/711).

### Strawman "refresh" baseline (isolated, for contrast)

Single-user smoke calls during the same session: playback ~60–88 ms median, dashboard ~62 ms median. Isolated performance is fine; everything collapses under concurrency because of the pool.

## Root cause

Error log (load instance, otherwise unmodified app code):

```
[ERROR] GET /videos/1/playback - Status: 500
Timed out fetching a new connection from the connection pool.
  More info: http://pris.ly/d/connection-pool
  (Current connection pool timeout: 10, connection limit: 9)
  code: 'P2024', meta: { modelName: 'Enrollment', connection_limit: 9, timeout: 10 }
  at Object.evaluateGate (src/services/quizService.js:275:22)
  at ensureBunnySequentialAccess (src/middlewares/bunnySequentialAccess.js:7:18)
```

- **`src/config/db.js` = bare `new PrismaClient()`** → Prisma defaults to `connection_limit = num_cpus*2+1 ≈ 9` (actual runtime value 9) and pool timeout 10 s.
- Every playback request runs the **sequential gate**: `evalutateGate` (Enrollment find → course videos → progress find → quiz/attempt → exemption — ~5–7 *sequential* `prisma.*` awaits) then `getPlaybackAccess` (~2 more). That is **~8 pool-slot acquisitions per playback**; login is bcrypt + ~2 queries.
- 200 concurrent students → 200×8 ≈ 1600 pool-slot waits stacked on 9 connections → 10 s timeout (P2024) before most ever reach SQL → 500s, and the queue adds 30–40 s to those that do.
- **DB was blameless**: mid/post-run `pg_stat_activity` = 16 idle, 1 active; no lock contention, no query-time explosion. This is an app-layer throughput wall (pool size + serial query chain), exactly the risk flagged in Stage-1 findings for `src/config/db.js`.

## What this proves / disproves

- ✅ **P1 indexes holding**: no new full-table-scan or plan regressions observed; isolated endpoint latencies are healthy.
- ✅ **Rate limiting works as designed** (and 1000/15min global was raised to 1M under LOAD_TEST to let the herd through — previous 429 wall on port 3005 confirmed).
- ❌ **Sequential-gate design cannot multiplex** at > ~15-20 concurrent students on one instance. The dominant latency is queued-in-pool time, not SQL.
- ❌ **Login** already starves at 500 concurrent (bcrypt + pool contention) — 42.2% success.

## Recommendations (application layer, then DB rollback check)

Priority-ordered for launch feasibility:

1. **P0 — Connection pool sizing/strategy (`src/config/db.js`)**: raise `connection_limit` explicitly (and consider `pool_timeout` tuning), sized against Supabase/PgBouncer pool (transaction mode) — Supabase budget is ~60 conns (4× or 8× micro), so a reasonable per-instance cap (e.g. 15–20) plus concurrent-instance math. Do **not** go to zero; keep on transaction pooler.
2. **P0/P1 — Flatten `evaluateGate` per-request query chain**: the sequential-await gate should be one parallelized `Promise.all` batch (or a single `$queryRaw`/joined query + in-memory logic). Cuts ~8 round-trips → 1–2 per playback, removing the amplifier that makes the pool wall hit at 200 VUs.
3. **P1 — Consider caching gate state per (user, video)** (Redis) with invalidation on progress/quiz/attempt/exemption writes, so question 2 rarely runs under load.
4. **P2 — After pool + gate fixes, re-run both k6 scenarios** to show p(95) → <2 s and >95% success before production rollout resumes.
5. **P2 — DB side is clean**; no further index churn proposed. P1 indexes proven at 10x cohort (506 users) under load.

Note: any config/code change for items 1–3 must go through the normal plan → grill → execute → review → verify flow and pair with the FE handoff if API behavior changes (gate shape unaffected on the wire — it's internal perf).

## Post-fix re-run (2026-09-15)

Application-layer P0 fixes applied per the recommendations above, then both k6 scenarios re-run against the same staging cohort (500 users) on a `LOAD_TEST=true` sibling (port 3006, pool 40).

**Fix scope:** explicit `connection_limit` (+ optional `DATABASE_CONNECTION_LIMIT` env, default 20) in `src/config/db.js`; `evaluateGate` flattened from ~7 sequential awaits to 2 parallel batches; gate verdict cached as `v1:gate:{userId}:{videoId}` (TTL 300s) in Redis with invalidation on every gate-state write (video completion, quiz submit/reset/grade/exemption, enroll/unenroll, course reorder, AI-graded finalize); playback fast path reuses the gate's fetched video (`req.gateVideo`) skipping `getPlaybackAccess`'s 2 redundant DB round-trips.

### Phase 2a — playback + dashboard (post-fix, cache warmed)

Same script: 200 VUs × 2000 playback iterations + 3 VUs constant 3min dashboard poll.

| Metric | Playback | Dashboard | Aggregate |
|---|---|---|---|
| Success rate | 100.00% (2000) | 100.00% (228) | 0.00% failed |
| Median | 223 ms | 1.33 s | 231 ms |
| p(90) | 284 ms | 1.47 s | 1.3 s |
| p(95) | 289 ms | 1.56 s | **1.34 s** |

**All thresholds passed** (`http_req_duration p(95) < 2000`, `rate > 0.95`). Improvement vs pre-fix: playback p95 **48.7 s → 289 ms**.

**Cold-cache caveat:** the first gate evaluation per (student, video) per 5-min window still requires the 2-batch DB work (~1.4 s single-user). Under a 200-concurrent **simultaneous cold** burst competing with the dashboard's 16-query fanout, playback tails to ~6 s p95 for that window; afterwards the cache is warm and steady-state is the table above. Bounded by per-user TTL, not unbounded.

**Isolation proof:** warm gate cache + `/admin/dashboard` in flight + 200 concurrent playbacks → playback p95 332 ms (the fast path does not re-enter the pool, so the dashboard's 16 parallel queries no longer degrade it).

### Phase 2b — login herd (post-fix)

| Metric | Login | /user/me |
|---|---|---|
| Success rate | **100.00%** (500/500) | 100.00% (500/500) |
| Median | 22 s | 17 s |
| p(95) | 40 s | 27 s |

Success objective met (0 failures vs 48.2% pre-fix overall). **Duration still exceeds P2 target** (`p(95)<3000`): bcrypt hashing cost + pool contention at 500 **simultaneous** fresh logins. This is outside the gate/playback fix scope (login does not touch the gate) → flagged **P2**: async-login/worker offload for bcrypt or higher pool headroom; re-test.

### Environment after test

- `app.js` LOAD_TEST override **reverted** (git diff clean); global 1000/15min + login 20/15min restored.
- 3006 sibling **killed**; `rl:*` + `v1:gate:*` Redis buckets **flushed**; cohort intact.
- Surviving code changes (all staged/verified, nothing on the wire changed): `db.js` pool config, flattened `evaluateGate` + Redis cache + invalidation wiring, playback fast path, reorder gate invalidation.

## Environment state after test

- `app.js` rate-limit override **reverted** (git diff clean for the file); global 1000/15min + login 20/15min restored.
- Load-test sibling (port 3006, PID 256) **killed**; primary server on 3005 untouched throughout.
- Redis `rl:*` buckets **flushed** (global + login for `::ffff:127.0.0.1`) so the real local client isn't blocked by test traffic.
- Staging synthetic cohort intact: 500 users, 500 enrollments, 500 progress (`tmp/k6-*`, `tmp/gen-seed.js`, `tmp/launch-loadtest.js` artifacts remain).
- **Cleaning follow-up requires user sign-off** (delete `%loadtest.local` users + tmp artifacts).

## Close-out (2026-09-15) — cleanup + commit readiness

### Cleanup (user-approved, executed)

- **500-user cohort deleted**: `cleanup-loadtest-cohort.js` removed all users with email `%@loadtest.local` (child-first `$transaction`: quizAttempt → gateExemption → assignmentAnswer → submission → bunnyVideoProgress → enrollment → payment → certificate → notification → user). Remaining user rows: **15** (admin + demo seeds + real staging users). Cascade-verified; non-cascading children explicitly deleted first.
- **All `tmp/` artifacts removed**: k6 scripts, summaries, JWT tokens, SQL seeds, `gen-seed.js`, `launch-loadtest.js`, `split-sql.js`, server/loadtest logs. `tmp/` now empty.
- Post-cleanup counters: enrollments 7, progress 13, attempts 26, exemptions 0, notifications 19 (only demo/seed residue).

### Commit readiness — staged (9 files, WIP excluded)

| Group | Files |
|---|---|
| P1 indexes migration | `prisma/migrations/20260914120000_p1_perf_indexes/migration.sql` |
| Prisma schema sync | `prisma/schema.prisma` (+10: QuizAttempt + BunnyVideo P1 indexes only) |
| Pool config | `src/config/db.js` |
| Gate flatten + cache | `src/services/quizService.js` |
| Playback fast path + reorder invalidation | `src/controllers/bunnyVideoController.js` |
| Gate invalidation (enroll/adminEnroll/unenroll) | `src/controllers/enrollmentController.js` |
| Gate invalidation (reset/exemption grant/revoke) | `src/controllers/quizController.js` |
| Gate invalidation (markVideoCompleted) | `src/controllers/videoProgressController.js` |
| `req.gateVideo` attach | `src/middlewares/bunnySequentialAccess.js` |

- **Entangled files staged as reconstructed blobs** (HEAD + only this round's hunks), so the commit is self-contained and buildable without WIP:
  - `quizService.js` staged WITHOUT the pre-existing `utils/quizKeyResolver.js` resolver refactor (inline resolvers restored); `node --check` passed on the index blob; no `quizKeyResolver` reference remains.
  - `schema.prisma` staged WITHOUT WIP fields (`passwordResetToken`) and WIP Assignment↔BunnyVideo relations; `prisma validate` passed on the index blob.
- **Left unstaged/untracked (not part of this commit)**: auth-limiter WIP (`authController.js`, `routes/auth.js`, `assignmentController.js`, `aiGrader/queue.js`, `tests/auth-limiter.test.js`, `plans/auth-limiter-logout-fix.md`, migrations `20260913035457_*`, `20260913092006_*`), graphify skill install (`.gitignore`, `skills-lock.json`, `.agents/skills/graphify/`), `src/utils/quizKeyResolver.js`, logs.
- `git diff --cached --stat`: 9 files, +277/−103.

## Security lockdown (2026-09-15) — applied to staging

Answer to "are DB + cache at max security/performance?": **No — not max** before
today. Performance validated (P1 + pool + gate cache, see above); security had a
real defense-in-depth gap now closed:

### Finding (verified on staging)
Supabase's default grants left **`anon`/`authenticated` with full DML
(SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER) on ALL 21 `public`
tables** — `User`, `Quiz`, `QuizAttempt`, `Payment`, `_prisma_migrations`, etc.
Unsafe *only* by luck: RLS is enabled deny-by-default with zero policies, so
non-owner roles see no rows. The `20260909110000_enable_rls` migration even
claims "anon/authenticated hold no grants" — that intent was never enforced.
One stray RLS policy, a future table created without RLS, or a PostgREST
caller with the anon key would have been a data breach.

### Fix — migration `20260915120000_lockdown_public_schema` (staging applied)
- `REVOKE ALL PRIVILEGES ON ALL TABLES/SEQUENCES/FUNCTIONS IN SCHEMA public FROM "anon","authenticated"`
- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres ... REVOKE ...` — future
  Prisma-created tables don't re-grant (Supabase's `supabase_admin` defaults
  left intact; RLS deny-by-default still covers that path).
- `CREATE INDEX IF NOT EXISTS "Certificate_courseId_idx"` — the only unindexed
  FK flagged by the advisor.

**Verified after apply:**
- `role_table_grants` for `anon`/`authenticated` in `public` → **empty**.
- `Certificate_courseId_idx` present, valid.
- `rls_auto_enable` ACL → `{=X/postgres,postgres=X/postgres,service_role=X/postgres}`
  (no anon/authenticated EXECUTE).
- App role (`postgres`, table owner) unaffected — bypasses RLS, full access kept.
- Migration recorded via `prisma migrate resolve --applied` (staging status
  still clean/up-to-date; prod needs same resolve after applying SQL).

### Also
- `sslmode=require` added to `DATABASE_URL` + `DIRECT_URL` in `.env` and
  `.env.example` (pooler already rejects plaintext; now explicit defense-in-depth).
- `rls_auto_enable` retained as an event trigger (revoked from anon/auth;
  still fires on DDL as owner). Not removable via pooler — non-issue.

### Cache verdict
Redis gate cache is secure: `rediss://` TLS, URL-with-credentials never logged,
256KB value cap, 500ms command timeout, fail-open, per-user keys hold no PII,
`rl:`/`v1:` namespaces isolated. **No gaps found.**

### Remaining known follow-ups (unchanged, out of this scope)
- Unused-index cleanup (12 flagged incl. old overlapping `Quiz_bunnyVideoId_idx`,
  `Enrollment_userId_idx` dupes) — removal is a separate approved step with
  load-test evidence; do NOT drop on the INFO lint alone (the P1 indexes show
  "unused" too — timing artifact of warm-cache load).
- P2 login herd (bcrypt threadpool p95 40s under 500-simultaneous) — async-login
  offload, separate workstream.
- Cold-cache 6s tail (200-simultaneous cold burst + dashboard fanout) — bounded
  by 5-min TTL; optional dashboard query split.