-- P1 performance indexes (Stage-2 DB audit, 2026-09-14, STAGING).
--
-- These three indexes were applied to STAGING out-of-band with
-- CREATE INDEX CONCURRENTLY (zero-downtime, outside any transaction block)
-- and verified valid/ready via pg_index (indisvalid, indisready) plus
-- EXPLAIN ANALYZE planner proof (see Stage-2 report).
--
-- This migration is recorded with:
--   npx prisma migrate resolve --applied "20260914120000_p1_perf_indexes"
-- and its statements intentionally use PLAIN (non-concurrent) CREATE INDEX:
-- Prisma replays migration files inside a transaction (including shadow-DB
-- builds for future `migrate dev`), where CONCURRENTLY is illegal and would
-- break every future migration workflow. IF NOT EXISTS keeps replays safe.
--
-- Rollback per index (run standalone, never in a transaction):
--   DROP INDEX CONCURRENTLY "BunnyVideo_course_status_position_idx";
--   DROP INDEX CONCURRENTLY "QuizAttempt_user_quiz_status_score_idx";
--   DROP INDEX CONCURRENTLY "QuizAttempt_quiz_status_started_idx";
-- Old overlapping indexes (Quiz_bunnyVideoId_idx dup, Enrollment_userId_idx,
-- BunnyVideo_courseId_idx, QuizAttempt_quizId_idx) are KEPT for now per
-- directive; removal is a separate approved step after load-test evidence.

-- P1-1: sequential-gate ordering + course video listing.
CREATE INDEX IF NOT EXISTS "BunnyVideo_course_status_position_idx" ON "BunnyVideo"("courseId", status, position);

-- P1-2: quiz best-attempt lookup (userId, quizId, status) + scorePercent DESC.
CREATE INDEX IF NOT EXISTS "QuizAttempt_user_quiz_status_score_idx" ON "QuizAttempt"("userId", "quizId", status, "scorePercent" DESC);

-- P1-3: per-quiz status-filtered attempt lists ordered by startedAt DESC.
CREATE INDEX IF NOT EXISTS "QuizAttempt_quiz_status_started_idx" ON "QuizAttempt"("quizId", status, "startedAt" DESC);
