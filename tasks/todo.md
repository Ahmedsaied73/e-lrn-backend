# Todo — Q-5 attempt snapshot

Repo: `H:\e-learning-platform` (`ai-grader`). Prior batch-1 record preserved in git.

## T1: migration + generate (M)
**Description:** Add `quizSnapshot Json?` to `QuizAttempt` with Q-5 comment;
migrate + regenerate client.
**Acceptance criteria:**
- [x] `prisma migrate status` clean; Prisma client exposes `quizSnapshot`
- [x] Existing rows read as NULL (no backfill, no data change)
**Verification:**
- [x] `npx prisma migrate status`; `node -e` import check on generated client
- [x] Fallback used only if shadow DB blocked (record which path in commit msg)
**Dependencies:** None
**Files likely touched:** `prisma/schema.prisma`, `prisma/migrations/*/migration.sql`
**Estimated scope:** Medium (schema + migration)

## Checkpoint A
- [x] Migration applied; server restarted on new client; `/user/me` smoke OK

## T2: snapshot-on-start + resolvers (S)
**Description:** `startAttempt` create writes `quizSnapshot: { surveyJson,
answerKey }` from the in-tx quiz row; add exported
`resolveAttemptKey`/`resolveAttemptSurvey` (snapshot-first, live fallback).
**Acceptance criteria:**
- [x] New attempt row carries byte-identical snapshot of the start-time key
- [x] Resolver returns snapshot when present, live key when NULL
**Verification:**
- [x] `node --check`; V1 probe script (start as scratch student → read row)
**Dependencies:** T1
**Files likely touched:** `src/services/quizService.js`
**Estimated scope:** Small (1 file)

## T3: submit/stale/expired snapshot-first (M)
**Description:** `submitAttempt`, `finalizeStaleAttempt`, EXPIRED branches
resolve via helpers instead of `attempt.quiz.answerKey`.
**Acceptance criteria:**
- [x] Mid-flight key edit does not change grading of an in-flight attempt
- [x] EXPIRED totals use the attempt's key
**Verification:**
- [x] V2 proof script (edit → submit → assert OLD-key scores → restore key)
**Dependencies:** T2
**Files likely touched:** `src/services/quizService.js`
**Estimated scope:** Medium (1 file, 3 paths)

## T4: essay + AI paths snapshot-first (S)
**Description:** `gradeEssayAttempt`, `applyAiVerdict`, AI `worker.js` prompt
load, `queue.js` enqueue enumeration resolve via snapshot.
**Acceptance criteria:**
- [x] Essay question set + points come from the attempt's key on all 4 paths
- [x] Enqueue after a mid-flight edit still targets the attempt's essays
**Verification:**
- [x] V3 script (grade/verdict after key edit → old-key essay set)
**Dependencies:** T2
**Files likely touched:** `src/services/quizService.js`,
  `src/services/aiGrader/worker.js`, `src/services/aiGrader/queue.js`
**Estimated scope:** Small (3 files, one-line-ish each)

## T5: result endpoint snapshot-first (S)
**Description:** `getQuizResult` per-question review resolves via snapshot
(result must show the key the attempt was graded against).
**Acceptance criteria:**
- [x] Post-edit result review shows OLD correct answers + scores
- [x] NULL-snapshot old attempts still render (live fallback)
**Verification:**
- [x] V4/V5 script asserts
**Dependencies:** T2
**Files likely touched:** `src/controllers/quizController.js`
**Estimated scope:** Small (1 file)

## T6: proof run + compat + commit (M)
**Description:** Full V1–V5 run, net-zero asserts (scratch student deleted,
key restored byte-identical), BE smoke, single code commit (+ T1 migration
commit already landed).
**Acceptance criteria:**
- [x] V1–V5 all pass; fixtures byte-identical after cleanup
- [x] p2-verify perf matrix still green (no regression from resolvers)
**Verification:**
- [x] Scripts in Temp; BE smoke; `git status` shows only intended files
**Dependencies:** T3, T4, T5
**Files likely touched:** (none — verification + commit)
**Estimated scope:** Medium (verification-heavy)

## Checkpoint B: complete
- [x] Commits: T1 migration; T2–T5 code; evidence in messages
- [x] Explicitly NOT in this batch: Docker/env, AI-4, S-8, dep prune, D-5,
      F-1, F-4, tests
