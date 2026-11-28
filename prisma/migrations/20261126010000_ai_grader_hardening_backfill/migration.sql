-- AI Grader Production Hardening (Part 2/2): backfill legacy statuses + indexes

UPDATE "AiGradingJob"
  SET status = 'DONE_APPLIED', "appliedAt" = COALESCE("appliedAt", "updatedAt")
  WHERE status::text = 'DONE' AND applied = true;

UPDATE "AiGradingJob"
  SET status = 'NEEDS_REVIEW', reason = COALESCE(reason, 'LOW_CONFIDENCE')
  WHERE status::text = 'DONE' AND applied = false;

UPDATE "AiGradingJob"
  SET status = 'NEEDS_REVIEW', reason = COALESCE(reason, 'AI_FAILED')
  WHERE status::text = 'FAILED';

CREATE INDEX IF NOT EXISTS "AiGradingJob_status_nextRunAt_idx" ON "AiGradingJob"("status", "nextRunAt");
CREATE INDEX IF NOT EXISTS "AiGradingJob_inputHash_idx" ON "AiGradingJob"("inputHash");
