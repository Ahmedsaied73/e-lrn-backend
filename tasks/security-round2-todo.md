# Todo — Security Round 2 (remaining audit tail)

Repo: `H:\e-learning-platform` (BE `Dev`). Mirror of `plans/security-round2-plan.md`.
Do NOT start parked items (P-A…P-C) without explicit user order.
Do NOT touch the unrelated `tasks/todo.md` run-to-zero workstream.

## Phase 0 — Quick real bugs
- [x] T0.1 J3: fix BullMQ jobId sanitization collision — append shortHash(qName) (`src/services/aiGrader/queue.js:89`)
- [x] T0.2 S6: validate assignment `fileUrl` — http(s) scheme + length cap + non-MCQ only (`assignmentController.js`)
- [x] T0.3 S1: `isAdmin(req)` DB-verified helper; replace 5 student-path `req.user.role !== 'ADMIN'` checks (`middlewares/index.js`, `assignmentController.js`, `videoProgressController.js`)

### Checkpoint A
- [x] `node --check` clean; `npm test` green; endpoint smoke

## Phase 1 — Authz spine
- [x] T1.1 S2: enrollment gates on `getAssignmentStatus`, `checkVideoCompletion`, `getCourseVideoProgress` (403 NOT_ENROLLED; admin bypass)

### Checkpoint B
- [x] Tests pass; unenrolled 403 / enrolled 200 smoke

## Phase 2 — Abuse surface / robustness
- [x] T2.1 S3: scoped rate limiter on `/webhooks/bunny/stream` (600/5min, pre-raw, distinct `rl:webhook:` namespace, HMAC-safe)
- [x] T2.2 F2: inactivity timeout on Bunny `uploadVideoStream` (`req.setTimeout(30s)` + unpipe/destroy on stall)
- [x] T2.3 S5: truncate Bunny error bodies in `BunnyApiError` (500-char cap; full body kept on `err.body` for server-side looks)

### Checkpoint C
- [x] Tests pass (4/4); smoke 17/17 fully incl. webhook flood→429 + bogus sig→401

## Phase 3 — Caching (single-flight first)
- [x] T3.1 J2: single-flight mutex in `cache.withCache` (in-process keyed Map; fails open)
- [x] T3.2 P1: cache `searchContent` (60s, shortHash of full filter vector; raw rows cached — host URL shaping per request)
- [x] T3.3 P2: cache `getCourseById` (60s; **per-user key** `byid:{courseId}:u{userId}` — the payload embeds user-scoped progress/enrollment, so a courseId-only key would leak; invalidated on course create/update/delete via existing delPrefix + new per-user dels on enroll/unenroll/markVideoCompleted)
- [x] T3.4 P3: cache admin `getDashboardStats` (30s; admin-only data → single global key)

### Checkpoint D
- [x] Tests pass (4/4); smoke 17/17 incl. single-flight 5→1, P2 cross-user isolation + enroll/unenroll invalidation, dashboard + search identical-repeat; DB net-zero after runs

## Phase 4 — Ops visibility
- [x] T4.1 J1: admin surface for failed `AiGradingJob`s (list + retry)
  - GET `/admin/ai-grading/jobs?status=&page=&limit=&search=` — default **FAILED**, leak-safe select (never answerKey/responses/essayFeedback), limit clamp 1..100, `{ success, data, pagination }`
  - POST `/admin/ai-grading/retry` — body `{ attemptIds?: number[] }`; 400 on invalid; absent body → **all FAILED attempts**; per-attempt before/after FAILED counts; lazy-require + never-throw (no-op if aiGrader folder deleted)
  - `enqueueAiGrading(attemptId, { freshJobIds })` — appends `-<base36 ts>` nonce to BullMQ jobId so a manual retry re-adds past `removeOnFail: 5000` dedupe (DB upsert + worker re-validation keep idempotency; normal submit path untouched)

### Checkpoint E
- [x] Tests pass (4/4); J1 smoke 17/17 (list envelope, leak-safe, status filters, 400/limit-clamp, 401/403 authz, retry validation, no-op, synthetic FAILED row search+retry, zero side effects; non-GRADING attempt so no real Gemini job fires)

## Phase 5 — Platform hygiene
- [x] T5.1 F1: inventory external storage usage, then orphan cleanup
  - Inventory: local `uploads/` = 0 files (5 empty subdirs); **Supabase `quiz-images` bucket IS used** (upload `POST /quizzes/images` → UUID filename, no tracking table). Found 2 orphaned objects (Sept 9 demo) → cross-checked zero quiz references → removed via Storage API. Bucket now empty.
  - Fix (no schema change needed — surveyJson IS the source of truth): `removeQuizImagesBestEffort` + `extractBucketObjectNames` in `supabaseClient.js`; wired into `deleteQuiz`, `upsertQuiz` old-vs-new image diff, and `deleteCourse` (snapshot quiz surveyJsons pre-cascade). Third-party URLs never touched; best-effort only.
- [x] T5.2 I2: align access cookie maxAge ↔ JWT expiry (15 min; refresh 7 d) — `src/utils.js` default `'1h'` → `'15m'` (matches `cookie.js` access maxAge exactly)
- [x] T5.3 I3: `createCourse` attributes to `req.user.id` (authenticated ADMIN) with first-ADMIN fallback for scripts
- [x] T5.4 I5: removed blanket `defaultMaxListeners = 15` (`app.js`) — no emitter in-app needs >10
- [x] T5.5 I6: Dockerfile `node:22-alpine` (DECIDED)

### Checkpoint F — complete
- [ ] All acceptance criteria met; `node --check` clean; `npm test` green; servers live on new code; per-item commits; `plans/security-round1.md` + FE `frontend-handoff.md` updated where behavior changed

## Parked (do NOT start)
- P-A S4: MIME magic-byte sniffing — DECIDED: keep client MIME hint + document limitation (no transform stream)
- P-B I4: legacy `Video` model deprecation (needs user order)
- P-C: unrelated run-to-zero leftovers in `tasks/todo.md`