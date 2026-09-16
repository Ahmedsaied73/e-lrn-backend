# Implementation Plan: Security Round 2 — remaining audit tail (dependency-aware)

## Overview

Remaining findings from the two delivered audits (backend 74/100, DB 82/100)
after Batch 1 fixed the crash vector, BullMQ graceful shutdown, reconcile cron
lock, and input sanitization. This round closes the authz gaps, the webhook
abuse surface, the queue bug (jobId collision), single-flight cache stampede,
caching for hot paths, and a set of small hardenings. **No frontend changes in
this round** unless explicitly requested. **No legacy `Video` deprecation** in
this round (see Parked).

## Corrections from live code verification (supersede the audit)

| Finding | Audit claim | Reality (verified) | Impact on plan |
|---------|-------------|--------------------|----------------|
| S1 | JWT `role` trusted blindly | `authorizeAdmin` already re-checks role in DB (`src/middlewares/index.js:76`). Residual risk is only the 5 student-path `req.user.role !== 'ADMIN'` checks. | S1 narrows to those 5 sites. |
| I1 | "No HSTS" | Helmet enables `Strict-Transport-Security` by default (`app.js:84`). | I1 → verify-only, likely already satisfied. |
| F1 | "No Supabase Storage orphan cleanup" | Need to inventory actual Storage usage first (assignments use local `uploads/`; Bunny cleanup already exists in `deleteCourse`). | F1 becomes investigate-then-fix; gated on inventory. |

## Dependency graph (build order)

```
Phase 0  J3 (jobId collision) ── tiny, real bug, no deps
         S6 (fileUrl validation) ── no deps
         S1 (role correctness helper) ── no deps
             │
Phase 1  S2 (enrollment gates) ── depends on S1 helper (admin-skip)
             │
Phase 2  S3 (webhook rate limiter) ── app.js scoping, no deps
         F2 (Bunny upload inactivity timeout) ── no deps
         S5 (Bunny error truncation) ── no deps
             │
Phase 3  J2 (single-flight in cache.withCache) ── cache.js, no deps
             │
         P1/P2/P3 (search, course:id, dashboard caching) ── reuse J2 helpers
             │
Phase 4  J1 (AI grading failed-job surfacing) ── needs admin surface; no deps
             │
Phase 5  F1 (storage orphan cleanup) ── gated on inventory task
         I2 (cookie/JWT expiry alignment)
         I3 (createCourse teacher attribution)
         I5 (scope defaultMaxListeners)
         I6 (Dockerfile node:18 → node:22)
             │
Phase 6  S4 (MIME magic-byte sniffing) ── design decision, see Open questions
         I4 (legacy Video deprecation) ⟶ PARKED, needs user order
```

Rationale: cheap real bugs first (J3, S6), then the authz spine (S1→S2) since
every subsequent hardening operates on a trustworthy identity, then abuse/limits
surface (S3, F2, S5), then caching foundation (J2) before cache consumers
(P1–P3) so they share the single-flight primitive, then ops visibility (J1),
then platform hygiene (F1, I2, I3, I5, I6), with the one design-heavy item (S4)
last and the deprecation parked.

## Task list (mirrored in `tasks/security-round2-todo.md`)

### Phase 0 — Quick real bugs
- [ ] **T0.1 J3: fix jobId sanitization collision** — `src/services/aiGrader/queue.js:89`
  — append `cache.shortHash(qName)` to the BullMQ `jobId` so two question names
  that sanitize to the same string still produce distinct jobIds. Acceptance:
  distinct jobIds for colliding names; enqueue smoke green.
- [ ] **T0.2 S6: validate assignment `fileUrl`** — `src/controllers/assignmentController.js`
  submit path — enforce `http(s)` scheme, length cap (e.g. ≤ 2048 chars), and
  require it only for non-MCQ assignments. Reject invalid with 400. Acceptance:
  `javascript:`/`file:` URLs rejected; valid https URL stored.
- [ ] **T0.3 S1: role-correctness helper on student paths** — add async
  `isAdmin(req)` helper (in `src/middlewares/index.js`) that DB-verifies the role
  ONLY when the token claim says `ADMIN` (cheap for the common student case);
  replace the 5 `req.user.role !== 'ADMIN'` checks (assignmentController `getAssignment`,
  `submitAssignment`, `getVideoAssignments`, `getCourseAssignments`;
  videoProgressController `markVideoCompleted`). Acceptance: demoted admin's token
  no longer bypasses enrollment on student endpoints.

### Checkpoint A
- [ ] `node --check` all touched files; `npm test` green; quick manual smoke on the 3 endpoints.

### Phase 1 — Authz spine
- [ ] **T1.1 S2: enrollment gates on 3 read endpoints** —
  `getAssignmentStatus` (assignmentController:643), `checkVideoCompletion` +
  `getCourseVideoProgress` (videoProgressController:94,120). Add the same
  enrollment-with-admin-skip gate used by `getAssignment`, using the Phase 0
  helper. Acceptance: unenrolled student gets 403 `NOT_ENROLLED`; admin bypasses;
  enrolled user unchanged.

### Checkpoint B
- [ ] Tests pass; endpoint smoke: unenrolled 403, enrolled 200.

### Phase 2 — Abuse surface / robustness
- [ ] **T2.1 S3: scoped rate limiter on Bunny webhook** —
  mount a small `express-rate-limit` limiter on `/webhooks/bunny/stream`
  (e.g. 60 req / 5 min per IP) at `app.js:107` — must NOT break raw-body
  handling or HMAC verification. Acceptance: flood → 429; valid webhook still 200.
- [ ] **T2.2 F2: inactivity timeout on Bunny upload** —
  `src/integrations/bunny/bunnyStreamClient.js` `uploadVideoStream` — add
  `req.setTimeout(INACTIVITY_MS)` (e.g. 30 s) so a hung socket is killed but a
  slow multi-GB stream survives (fires only when *no bytes* flow). Clear on data.
  Acceptance: hung upload rejects within ~30 s; active stream unaffected.
- [ ] **T2.3 S5: truncate/sanitize Bunny error bodies** —
  `BunnyApiError` (bunnyStreamClient.js) — cap `body` used in the message
  (e.g. 500 chars) and stop persisting raw Bunny internals into user-facing
  AppError messages. Log full body server-side only. Acceptance: error responses
  for API clients contain no Bunny internal IDs.

### Checkpoint C
- [ ] Tests pass; webhook + upload smoke green.

### Phase 3 — Caching (single-flight first)
- [ ] **T3.1 J2: single-flight in `cache.withCache`** — `src/integrations/redis/cache.js`
  — in-process keyed mutex so concurrent same-key misses execute the loader once
  (in-process only; Redis lock not needed). Acceptance: N parallel misses → 1
  loader call; still fails open.
- [ ] **T3.2 P1: cache searchContent** — `src/controllers/searchController.js`
  — `withCache` on the course/video query block, TTL ~60 s, key via existing
  `shortHash` (query/type/grade/price/sort). Acceptable staleness documented.
- [ ] **T3.3 P2: cache `getCourseById`** — `src/controllers/coursesController.js`
  — `withCache` TTL ~60 s. **REALITY DEVIATION: key must be PER-USER** —
  the response embeds the authenticated user's `progress` + `enrollment`
  (user-scoped relation includes), so a courseId-only key would serve one
  student's completion state to every other student (cross-user leak). Key =
  `v1:courses:byid:{courseId}:u{userId}` (mirrors the existing per-user quiz-meta
  cache in quizController). Invalidated by create/update/delete (`delPrefix('v1:courses:')`
  already exists) **plus new per-user `del` added to enrollment create / admin-enroll /
  unenroll / markVideoCompleted** so a student's own fresh enrollment/completion shows
  immediately (no 60s stale "not enrolled"/"still locked"). Acceptance: two loads → one
  query for the same user; a second user never sees the first user's enrollment.
- [ ] **T3.4 P3: cache admin dashboard** — `src/controllers/adminController.js`
  `getDashboardStats` — wrap the `Promise.all` block in `withCache` TTL ~30 s.
  Acceptance: dashboard load hits cache; counts stay within TTL staleness.

### Checkpoint D
- [ ] Tests pass; cache hit/miss verified on 3 endpoints; invalidation smoke.

### Phase 4 — Ops visibility
- [ ] **T4.1 J1: surface failed AI-grading jobs** — new admin endpoint
  (`GET /admin/ai-grading/failed` or add to dashboard alerts) listing
  `AiGradingJob` rows with `status='FAILED'` + error, plus a manual retry action
  (re-enqueue). DB `AiGradingJob` row is already the durable audit — this only
  adds visibility/recovery. Acceptance: admin can list and retry failed jobs.

### Checkpoint E
- [ ] Tests pass; admin surface smoke.

### Phase 5 — Platform hygiene
- [ ] **T5.1 F1: storage orphan cleanup** — first **inventory** what external
  storage is actually populated (Supabase Storage buckets vs local `uploads/`),
  then add cleanup to `deleteCourse`/user-delete for confirmed orphans.
  If inventory shows nothing external is stored, record that and close F1 as
  not-applicable. Acceptance: no orphaned objects after course/user deletion (or
  documented N/A).
- [ ] **T5.2 I2: align cookie/JWT expiry** — `src/utils.js` + cookie set sites —
  access token expiry == cookie `maxAge` (pick 15 min; refresh stays 7 d).
  Acceptance: cookie and JWT expire within the same minute (verify via unit check).
- [ ] **T5.3 I3: `createCourse` teacher attribution** — `coursesController.js`
  — use `req.user.id` when the caller is ADMIN (fallback to first ADMIN only if
  `req.user` absent, e.g. script). Acceptance: course created by requester shows
  requester as teacher.
- [ ] **T5.4 I5: scope `defaultMaxListeners`** — `app.js:30` — drop the blanket
  override; set explicit limits on the specific EventEmitters that need them
  (accept if no emitter exceeds default — then delete the override).
- [ ] **T5.5 I6: Dockerfile runtime upgrade** — `node:18-alpine` (EOL Apr 2025)
  → `node:22-alpine` (**DECIDED**, grill); confirm no native-dep issues.
  Acceptance: `docker build` parses; container boots to health.

### Checkpoint F — complete
- [ ] All per-task acceptance criteria met; `node --check` clean; `npm test`
  green; servers live on new code; trees clean per-item commits; `plans/security-round1.md`
  + `frontend-handoff.md` updated where behavior/API changed.

## Parked (need user order — do NOT start)
- **P-A S4: MIME magic-byte sniffing** — **DECIDED (grill, held): keep client MIME
  hint + document limitation (comment + tracking note); do NOT implement the
  transform stream.** Bunny re-validates the bitstream, so residual risk is low.
- **P-B I4: legacy `Video` model deprecation/migration** — ADR + migration plan
  needed; large, cross-cutting, out of scope until user directs.
- **P-C** Existing `tasks/todo.md` run-to-zero leftovers (R3, R6, R7, R8 FE parts)
  — separate workstream, untouched.

## Risks and mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| Webhook limiter breaks raw-body/HMAC | High | Mount limiter BEFORE `express.raw`; limiter counts only, never parses body; test with valid signature |
| Single-flight loader change regresses cache | Med | Fail-open preserved; in-process only; watch harness |
| Caching dashboard/ course ID serves stale data | Low-Med | Short TTLs; existing `delPrefix` invalidation; document staleness |
| F2 timeout kills legit slow uploads | Med | Inactivity (byte-level) timeout, not total; bump limit generous |
| Role helper adds a DB read on token-ADMIN paths | Low | Lookup happens once per admin claim; students never pay |

## Open questions (grill — answer before Phase 6 / execution)
1. **S4 MIME sniffing approach:** magic-byte transform stream (accurate, adds a
   small read-through buffer) vs. keep client-MIME hint + rely on Bunny's own
   bitstream validation (zero code, documented limitation)? Default: **keep
   current hint + document**, unless you want the transform.
2. **Cache TTLs for search (60 s) / course (60 s) / dashboard (30 s):** acceptable,
   or prefer 0 (no cache) on any of these?
3. **J1 admin surface:** dashboard alert badge vs dedicated page — which? (determines
   T4.1 scope)
4. **Docker runtime:** `node:22-alpine` OK, or prefer LTS `node:20`/`node:24`?
5. **I5:** OK to delete the blanket `defaultMaxListeners` override if no emitter
   needs the bump?
6. **Batch order:** execute Phases 0→5 in this order, or land only the authz/cache
   phases first for review?