-- AI Grader Production Hardening: 5-state machine + outbox + metrics + review mode

-- 1. Create AiReviewMode enum & add to Quiz
DO $$ BEGIN
  CREATE TYPE "AiReviewMode" AS ENUM ('AUTO', 'REVIEW_REQUIRED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "Quiz" ADD COLUMN IF NOT EXISTS "aiReviewMode" "AiReviewMode" NOT NULL DEFAULT 'AUTO';

-- 2. Add new columns to AiGradingJob
ALTER TABLE "AiGradingJob" ADD COLUMN IF NOT EXISTS "reason" TEXT;
ALTER TABLE "AiGradingJob" ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMP(3);
ALTER TABLE "AiGradingJob" ADD COLUMN IF NOT EXISTS "nextRunAt" TIMESTAMP(3);
ALTER TABLE "AiGradingJob" ADD COLUMN IF NOT EXISTS "appliedAt" TIMESTAMP(3);
ALTER TABLE "AiGradingJob" ADD COLUMN IF NOT EXISTS "inputHash" TEXT;
ALTER TABLE "AiGradingJob" ADD COLUMN IF NOT EXISTS "criteriaBreakdown" JSONB;
ALTER TABLE "AiGradingJob" ADD COLUMN IF NOT EXISTS "tokensIn" INTEGER;
ALTER TABLE "AiGradingJob" ADD COLUMN IF NOT EXISTS "tokensOut" INTEGER;

-- 3. Extend AiGradingJobStatus enum & backfill
ALTER TYPE "AiGradingJobStatus" ADD VALUE IF NOT EXISTS 'RUNNING';
ALTER TYPE "AiGradingJobStatus" ADD VALUE IF NOT EXISTS 'DONE_APPLIED';
ALTER TYPE "AiGradingJobStatus" ADD VALUE IF NOT EXISTS 'SYSTEM_GRADED';
ALTER TYPE "AiGradingJobStatus" ADD VALUE IF NOT EXISTS 'NEEDS_REVIEW';

-- Commit enum value additions before using them in UPDATE (Postgres requirement)
COMMIT;
BEGIN;

UPDATE "AiGradingJob"
  SET status = 'DONE_APPLIED', "appliedAt" = COALESCE("appliedAt", "updatedAt")
  WHERE status::text = 'DONE' AND applied = true;

UPDATE "AiGradingJob"
  SET status = 'NEEDS_REVIEW', reason = COALESCE(reason, 'LOW_CONFIDENCE')
  WHERE status::text = 'DONE' AND applied = false;

UPDATE "AiGradingJob"
  SET status = 'NEEDS_REVIEW', reason = COALESCE(reason, 'AI_FAILED')
  WHERE status::text = 'FAILED';

-- 4. Indexes
CREATE INDEX IF NOT EXISTS "AiGradingJob_status_nextRunAt_idx" ON "AiGradingJob"("status", "nextRunAt");
CREATE INDEX IF NOT EXISTS "AiGradingJob_inputHash_idx" ON "AiGradingJob"("inputHash");
