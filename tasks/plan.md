# Implementation Plan: Q-5 attempt snapshot (grade-from-frozen-key)

## Overview
`startAttempt` freezes `{ surveyJson, answerKey }` onto the attempt row
(`quizSnapshot Json?`, NULL = pre-snapshot row). Every attempt-scoped read
(submit, stale-finalize, essay grade, AI verdict/worker/queue, result review)
resolves the key snapshot-first with live-key fallback. Quiz-level surfaces
(meta totals, start-time sanitize) stay live deliberately. One migration, no
backfill, fully net-zero verification (scratch student + restored key).

## Architecture decisions
- Single `quizSnapshot Json?` column holding `{ surveyJson, answerKey }`
  (one column, not two; surveyJson frozen for future result-rendering proof).
- `resolveAttemptKey(attempt)` / `resolveAttemptSurvey(attempt)` helpers in
  `quizService.js`, exported for controller + AI worker/queue. NULL snapshot →
  live key (current behavior preserved for old rows).
- Snapshot write happens inside the existing advisory-locked `startAttempt`
  transaction (no new race). All invalidation/caching behavior unchanged.
- Migration via `migrate dev`; fallback if Supabase blocks shadow DB: hand-write
  `migration.sql` + `migrate resolve --applied` + `generate` (used before).
- Commits: T1 migration alone; T2–T5 one code commit; T6 verification evidence
  in message. Server restart after migrate (Prisma client reload).

## Task list (also in `tasks/todo.md`)
- [x] T1 — migration + generate
- [x] Checkpoint A — migrate status clean, client has field
- [x] T2 — snapshot-on-start + resolvers
- [x] T3 — submit/stale/expired snapshot-first
- [x] T4 — essay + AI paths snapshot-first
- [x] T5 — result endpoint snapshot-first
- [x] T6 — mid-flight proof + compat + commit

## Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Supabase shadow-DB block on `migrate dev` | Med | Fallback: hand-written SQL + resolve-applied (documented above) |
| Attempt rows bloat (≤512KB snapshot each) | Low | Typical keys are small; noted, not optimized (no premature compression) |
| Missed live-key reader (76 grep hits) | Med | Enumerated: only attempt-scoped readers change (§below); meta/start stay live by decision |
| Fixture pollution during proof | Low | Scratch student (cascade-deleted) + byte-identical key restore, asserted |

## Attempt-scoped readers changing (all others stay live)
`submitAttempt` (:632/:638), `finalizeStaleAttempt` (:490-493),
`gradeEssayAttempt` (:752/:760), `applyAiVerdict` (:837/:845),
`aiGrader/worker.js:131/138`, `aiGrader/queue.js:62/68`,
`quizController getQuizResult` (:326/:339). Start-time EXPIRED branch (:424)
keeps the in-tx live row (identical to the snapshot being written).

## Open questions
1. Batch-2 order after Q-5: Docker/env repair next, or AI-4?
2. L-1 topology still unanswered (S-8 parked regardless).
