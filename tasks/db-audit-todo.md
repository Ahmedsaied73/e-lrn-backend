# DB Audit Todo — Stage 1 (READ-ONLY, EXPLAIN only, STOP after F)

## Checkpoint: plan files
- [x] `tasks/db-audit-plan.md` created; `plan.md`/`todo.md` untouched

## A: App→DB inventory
- [ ] All `prisma.*` ops mapped per file with filters/includes/orderBy/skip-take
- [ ] N+1 / loop / sequential-await / count+findMany flags with file:line
- [ ] $transaction / $queryRaw / $executeRaw list (expect ~zero raw)

## B: Schema + index baseline
- [ ] schema.prisma ↔ pg_indexes ↔ migrations reconciled
- [ ] Unindexed-FK (Certificate.courseId) + 10 unused-index hits dispositioned
- [ ] PK/FK/unique/check/nullability/type notes

## C: Query perf (EXPLAIN only) + pagination
- [ ] pg_stat_statements availability checked
- [ ] EXPLAIN (no ANALYZE) for gate/quiz/enrollment/notification/admin-list paths
- [ ] Every paginated endpoint: OFFSET vs keyset, ordering stability, index compat

## D: Connections / tx / cache / health
- [ ] db.js + env.js + redis client/store/cache read; pool math stated
- [ ] Every $transaction audited for length, external calls, hot rows
- [ ] Table sizes, bloat/vacuum, cache-hit, locks/connections (SELECT only)
- [ ] Redis: cacheable vs not, key/TTL/invalidation per candidate

## E: Security / privacy / abuse
- [ ] RLS ×21 no-policy + rls_auto_enable() DEFINER dispositioned
- [ ] Grants/roles, SECURITY DEFINER, search_path, extensions
- [ ] Raw-SQL injection scan; sensitive-column exposure (password/refreshToken/answerKey)
- [ ] Per-endpoint amplification (1 req → N queries × rows)

## F: Report + STOP
- [ ] 1x/10x/100x scale model; advisor validation
- [ ] Baseline metrics table with sources
- [ ] Findings CRITICAL→INFO with evidence/fix/risk/benefit/benchmark/rollback
- [ ] P0–P3 plan (CONCURRENTLY/lock notes), load-test plan, verification plan, rollback strategy
- [ ] STOP — await explicit Stage-2 authorization

## Checkpoint: Complete
- [x] 24-section report delivered in chat; no code/DB/config modified

## Stage 2 — P1 execution (STAGING ONLY, 2026-09-14)
- [x] Safety gate: connected project = staging (`ltageakmwodqsyfcoxjh`)
- [x] Data-API probe: anon `GET /rest/v1/Course?select=id` → HTTP 200, 0 rows (fail-closed, fragile — F-S1)
- [x] P1-1/2/3 CREATE INDEX CONCURRENTLY applied; all indisvalid+indisready, 16 kB each
- [x] EXPLAIN ANALYZE proof: P1-2 Index Only Scan pickup; P1-1/P1-3 usable (Bitmap on seqscan-off), planner seq-scans ≤24-row tables by design
- [x] `rls_auto_enable()` body reviewed → event-trigger only, search_path pinned → F-S2 HIGH→LOW
- [x] Grants census: anon+authenticated full DML on ALL 21 tables + migrations (F-S1 stands)
- [x] `deleteUser` re-verified: Notification CASCADEs, Certificate explicit → Stage-1 M4 WITHDRAWN
- [x] Lib check: helmet/bullmq/custom Redis rate store exist (no rate-limit-redis needed); p-limit deferred (no evidence); k6 v2.2.0 installed
- [x] Prisma sync: schema.prisma @@index ×3 + migration 20260914120000_p1_perf_indexes + resolve --applied; `migrate status` = up to date
- [x] Phase 2a playback + dashboard vs pregen-JWT load (200 VUs, 2000 iters) — **BLOCKED BY CONNECTION POOL**: P2024 `connection_limit:9 timeout:10`, med 46.3s, 14.6% 500s; the sequential gate churns ~8 pooled queries/request
- [x] Phase 2b login herd (500 VUs, 500 iters) — same pool exhaustion: login success 42.2% (med 11.99s), /user/me 74.4%
- [x] Root cause: bare `new PrismaClient()` in `src/config/db.js` → default pool 9, 10s timeout; DB itself idle (pg_stat_activity 16 idle, 1 active); 200 concurrent students saturate 9 connections
- [x] Load-test infra: LOAD_TEST=true temp override + 3006 sibling instance, pregen JWTs; **reverted app.js, killed PID 256 (3006), flushed rl buckets**; staging cohort 500 users/500 enrollments/500 progress **intact, cleanup pending**
- [x] Report delivered: `tasks/db-audit-phase2.md`
- [x] **POST-FIX RE-RUN (2026-09-15)**: explicit pool `connection_limit` (+ `DATABASE_CONNECTION_LIMIT` env override, default 20, staged at 40 for tests) in `src/config/db.js`; `evaluateGate` flattened into 2 parallel batches; gate state cached Redis as `v1:gate:{userId}:{videoId}` (TTL 300s) with invalidation on all gate-state write paths (progress, submit/reset/resetAttempt, exemption grant/revoke, enroll/adminEnroll/unenroll, reorder, AI-graded finalize); playback fast path uses gate's `_video` (skips `getPlaybackAccess` re-fetch)
- [x] **Phase 2a post-fix (warm cache)**: playback p95 **288ms** (was 48.7s), 100% success, dashboard p95 1.56s 100%, aggregate http_req_duration p95 **1.33s < 2s ✓ all thresholds passed**
- [x] **Phase 2a post-fix (cold cache)**: first-eval burst per 5-min window still tails ~6s p95 under 200 concurrent colds + dashboard's 16-query fanout competing for pool — bounded by per-user TTL; noted in report
- [x] **Phase 2b post-fix**: login herd 100% success (was 42.2%) but login p95 40s / me p95 27s — bcrypt + pool contention under 500 simultaneous logins; outside gate/playback scope, flagged P2
- [x] Surge-isolation test: warm gate cache + 1 `/admin/dashboard` (16 parallel Prisma queries) + 200 concurrent playbacks → playback p95 332ms (warm-cache path immune to dashboard's pool pressure)
- [x] Temp edits reverted (app.js LOAD_TEST override, bunnyVideoController instrumentation), 3006 sibling killed, `rl:*`/`v1:gate:*` Redis buckets flushed, cohort intact
- [ ] CLEANUP: DELETE staging cohort (`%loadtest.local`) + remove tmp/k6-* artifacts — user sign-off
