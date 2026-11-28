-- AI Grader Production Hardening (Part 1/2): enum + columns + enum value additions

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

-- 3. Extend AiGradingJobStatus enum (committed at end of this migration before backfill in Part 2)
ALTER TYPE "AiGradingJobStatus" ADD VALUE IF NOT EXISTS 'RUNNING';
ALTER TYPE "AiGradingJobStatus" ADD VALUE IF NOT EXISTS 'DONE_APPLIED';
ALTER TYPE "AiGradingJobStatus" ADD VALUE IF NOT EXISTS 'SYSTEM_GRADED';
ALTER TYPE "AiGradingJobStatus" ADD VALUE IF NOT EXISTS 'NEEDS_REVIEW';
