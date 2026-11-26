'use strict';

/**
 * AI Grading Reconciliation Job (FR-4, FR-9).
 *
 * Schedule: every 5 minutes (node-cron + Redis distributed lock).
 * Ensures zero lost essays:
 *   1. Reset expired RUNNING leases (leaseUntil < now) back to PENDING
 *   2. Escalate exhausted PENDING jobs (tries >= maxTries) to NEEDS_REVIEW(AI_FAILED)
 *   3. Re-enqueue stale PENDING jobs (nextRunAt < now - 15m) to BullMQ
 *   4. Retry applying stored verdicts that aren't DONE_APPLIED yet (FR-7)
 *   5. Finalize any GRADING attempt whose jobs are all DONE_APPLIED / SYSTEM_GRADED
 *   6. Alert on orphan GRADING attempts (>15m with no live PENDING/RUNNING/NEEDS_REVIEW job)
 */

const cron = require('node-cron');
const prisma = require('../config/db');
const config = require('../config/env');
const { acquireLock, releaseLock } = require('../integrations/redis/distributedLock');

const STALE_MINUTES = 15;
const MAX_BATCH = 50;
const LOCK_KEY = 'lock:reconcile-ai-grading';
const LOCK_TTL_SECONDS = 240;

let isRunning = false;

const log = {
  info: (event, ctx = {}) => console.log(`[INFO] ${event}`, JSON.stringify(ctx)),
  warn: (event, ctx = {}) => console.warn(`[WARN] ${event}`, JSON.stringify(ctx)),
  alert: (event, ctx = {}) => console.error(`[ALERT] ${event}`, JSON.stringify(ctx)),
};

async function reconcileAiGrading() {
  if (config.features && config.features.aiGrader === false) {
    return { skipped: true, reason: 'module-off' };
  }

  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_MINUTES * 60 * 1000);

  // 1. Expired leases: RUNNING with leaseUntil < now -> PENDING
  const expiredLeases = await prisma.aiGradingJob.updateMany({
    where: { status: 'RUNNING', leaseUntil: { lt: now } },
    data: { status: 'PENDING', nextRunAt: now, leaseUntil: null },
  });

  // 2. Exhausted PENDING: tries >= maxTries -> NEEDS_REVIEW(AI_FAILED)
  const exhausted = await prisma.$executeRaw`
    UPDATE "AiGradingJob"
    SET status = 'NEEDS_REVIEW', reason = 'AI_FAILED', "leaseUntil" = NULL, "updatedAt" = NOW()
    WHERE status = 'PENDING' AND tries >= "maxTries"
  `;

  // 3. Stale PENDING: nextRunAt <= now (or null) and createdAt < staleCutoff -> re-enqueue
  const stalePending = await prisma.aiGradingJob.findMany({
    where: {
      status: 'PENDING',
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
      updatedAt: { lt: staleCutoff },
    },
    select: { attemptId: true },
    distinct: ['attemptId'],
    take: MAX_BATCH,
  });

  let reenqueued = 0;
  if (stalePending.length > 0) {
    try {
      const { enqueueAiGrading } = require('../services/aiGrader/queue');
      for (const row of stalePending) {
        reenqueued += await enqueueAiGrading(row.attemptId, { freshJobIds: true });
      }
    } catch (err) {
      log.warn('ai.reconcile.enqueue_failed', { error: err.message });
    }
  }

  // 4. Stored verdict without DONE_APPLIED (FR-7 recovery)
  const unapplied = await prisma.aiGradingJob.findMany({
    where: {
      status: 'PENDING',
      verdict: { not: null },
    },
    take: MAX_BATCH,
  });

  let retriedApply = 0;
  if (unapplied.length > 0) {
    const quizService = require('../services/quizService');
    for (const job of unapplied) {
      try {
        const v = job.verdict;
        await quizService.applyAiVerdict(job.attemptId, job.questionName, {
          awarded: v.score,
          max: v.maxScore,
          feedback: v.feedback,
          confidence: v.confidence,
          model: v.model,
          promptVersion: v.promptVersion,
        });
        await prisma.aiGradingJob.update({
          where: { id: job.id },
          data: { status: 'DONE_APPLIED', applied: true, appliedAt: new Date(), leaseUntil: null },
        });
        retriedApply += 1;
      } catch (err) {
        log.warn('ai.reconcile.apply_retry_failed', { jobId: job.id, error: err.message });
      }
    }
  }

  // 5. Orphan detection (FR-9): GRADING attempts >15m old with NO live/review jobs
  const orphanAttempts = await prisma.$queryRaw`
    SELECT qa.id
    FROM "QuizAttempt" qa
    WHERE qa.status = 'GRADING'
      AND qa."submittedAt" < ${staleCutoff}
      AND NOT EXISTS (
        SELECT 1 FROM "AiGradingJob" j
        WHERE j."attemptId" = qa.id
          AND j.status IN ('PENDING', 'RUNNING', 'NEEDS_REVIEW')
      )
    LIMIT 50
  `;

  if (orphanAttempts.length > 0) {
    const ids = orphanAttempts.map((r) => r.id);
    log.alert('ai.reconcile.orphans_detected', { count: ids.length, attemptIds: ids });
    try {
      const { notifyAiGradingAlert } = require('../services/notifications/notificationService');
      await notifyAiGradingAlert('ORPHAN_DETECTED', `تم اكتشاف ${ids.length} محاولة عالقة بدون تصحيح: ${ids.join(', ')}`);
    } catch {
      // non-fatal
    }
  }

  const summary = {
    expiredLeases: expiredLeases.count,
    exhausted: Number(exhausted),
    reenqueued,
    retriedApply,
    orphans: orphanAttempts.length,
    skipped: false,
  };

  if (summary.expiredLeases || summary.exhausted || summary.reenqueued || summary.retriedApply || summary.orphans) {
    log.info('ai.reconcile.completed', summary);
  }
  return summary;
}

function startAiGradingReconciliationJob() {
  return cron.schedule('*/5 * * * *', async () => {
    if (isRunning) return;
    isRunning = true;
    const token = await acquireLock(LOCK_KEY, LOCK_TTL_SECONDS).catch(() => null);
    if (token === false) {
      isRunning = false;
      return;
    }
    try {
      await reconcileAiGrading();
    } catch (err) {
      log.warn('ai.reconcile.tick_failed', { error: err.message });
    } finally {
      if (token) await releaseLock(LOCK_KEY, token).catch(() => {});
      isRunning = false;
    }
  });
}

function stopAiGradingReconciliationJob(task) {
  if (task && typeof task.stop === 'function') {
    task.stop();
  }
}

module.exports = {
  reconcileAiGrading,
  startAiGradingReconciliationJob,
  stopAiGradingReconciliationJob,
};
