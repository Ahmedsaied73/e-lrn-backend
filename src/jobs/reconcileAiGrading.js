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
const distributedLock = require('../integrations/redis/distributedLock');

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

  // 1. Expired leases: RUNNING with leaseUntil < now -> PENDING.
  //    Collect the capped page first — the reset below makes them ineligible.
  //    Scope the reset to that page: rows beyond it stay RUNNING with an
  //    expired lease, so a later tick can pick them up and re-enqueue them.
  const expiredRows = await prisma.aiGradingJob.findMany({
    where: { status: 'RUNNING', leaseUntil: { lt: now } },
    select: { id: true, attemptId: true },
    distinct: ['attemptId'],
    take: MAX_BATCH,
  });
  const expiredLeases = await prisma.aiGradingJob.updateMany({
    where: {
      status: 'RUNNING',
      leaseUntil: { lt: now },
      id: { in: expiredRows.map((r) => r.id) },
    },
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

  // Expired leases and stale PENDING rows both need a fresh enqueue this tick.
  // One attempt may appear in both lists, so dedupe by attemptId.
  const reenqueueIds = [...new Set([
    ...expiredRows.map((r) => r.attemptId),
    ...stalePending.map((r) => r.attemptId),
  ])];

  let reenqueued = 0;
  if (reenqueueIds.length > 0) {
    try {
      const { enqueueAiGrading } = require('../services/aiGrader/queue');
      for (const attemptId of reenqueueIds) {
        reenqueued += await enqueueAiGrading(attemptId, { freshJobIds: true });
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
    for (const job of unapplied) {
      try {
        const quizService = require('../services/quizService');
        const v = job.verdict;
        const result = await prisma.$transaction(async (tx) => {
          const applied = await quizService.applyAiVerdictInTx(tx, job.attemptId, job.questionName, {
            awarded: v.score,
            max: v.maxScore,
            feedback: v.feedback,
            confidence: v.confidence,
            model: v.model,
            promptVersion: v.promptVersion,
          });
          await tx.aiGradingJob.update({
            where: { id: job.id },
            data: { status: 'DONE_APPLIED', applied: true, appliedAt: new Date(), leaseUntil: null },
          });
          return applied;
        });
        if (result.finalized) await quizService.postFinalize(job.attemptId, result.userId);
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
    reenqueuedLeases: expiredRows.length,
    retriedApply,
    orphans: orphanAttempts.length,
    skipped: false,
  };

  if (
    summary.expiredLeases ||
    summary.exhausted ||
    summary.reenqueued ||
    summary.reenqueuedLeases ||
    summary.retriedApply ||
    summary.orphans
  ) {
    log.info('ai.reconcile.completed', summary);
  }
  return summary;
}

/**
 * One lock-guarded reconciler tick. Dependencies are injectable so the lock
 * contract can be unit-tested without Redis or Postgres.
 *
 * acquire() returns { acquired, token }:
 *   { true, token } — we hold the lock; release the exact token afterwards.
 *   { true, null }  — fail-open (Redis unavailable); reconcile, nothing to release.
 *   { false, null } — another instance holds it; do not reconcile.
 * A throwing acquire is treated as "not acquired" (fail closed for this tick,
 * since the next cron tick will retry).
 */
async function runReconciliationTick({
  acquire = () => distributedLock.acquireLock(LOCK_KEY, LOCK_TTL_SECONDS),
  release = (token) => distributedLock.releaseLock(LOCK_KEY, token),
  reconcile = reconcileAiGrading,
} = {}) {
  if (isRunning) return { skipped: true, reason: 'in-progress' };
  isRunning = true;
  let lock = null;
  try {
    lock = await acquire().catch(() => ({ acquired: false, token: null }));
    if (!lock.acquired) return { skipped: true, reason: 'lock-held' };
    return await reconcile();
  } catch (err) {
    log.warn('ai.reconcile.tick_failed', { error: err.message });
    return { skipped: true, reason: 'error' };
  } finally {
    if (lock && lock.token) await release(lock.token).catch(() => {});
    isRunning = false;
  }
}

function startAiGradingReconciliationJob() {
  return cron.schedule('*/5 * * * *', () => {
    runReconciliationTick();
  });
}

function stopAiGradingReconciliationJob(task) {
  if (task && typeof task.stop === 'function') {
    task.stop();
  }
}

module.exports = {
  reconcileAiGrading,
  runReconciliationTick,
  startAiGradingReconciliationJob,
  stopAiGradingReconciliationJob,
};
