'use strict';

/**
 * AI Grading Reconciliation Job (FR-4, FR-9).
 *
 * Schedule: every 5 minutes (node-cron + Redis distributed lock).
 * Ensures zero lost essays:
 *   1. Reset expired RUNNING leases (leaseUntil < now) back to PENDING
 *   2. Escalate exhausted PENDING jobs (tries >= maxTries) to NEEDS_REVIEW(AI_FAILED)
 *   3. Re-enqueue stale PENDING jobs (nextRunAt < now - 15m) to BullMQ
 *   4. Retry applying stored verdicts that aren't DONE_APPLIED yet (FR-7);
 *      finalizing a GRADING attempt happens inside the verdict transaction
 *   5. Detect orphan GRADING attempts (>15m, no live PENDING/RUNNING/NEEDS_REVIEW
 *      job) and alert admins — a read-only SELECT, skipped for scoped ticks
 */

const cron = require('node-cron');
const { Prisma } = require('@prisma/client');
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

/**
 * @param {{ attemptIds?: number[] }} [options] Optional positive-int attempt
 *   scope. When supplied, steps 1-4 touch only those attempts (used by tests
 *   against a shared DB). Omitted => the cron tick's global behaviour.
 */
async function reconcileAiGrading({ attemptIds } = {}) {
  if (config.features && config.features.aiGrader === false) {
    return { skipped: true, reason: 'module-off' };
  }

  // A malformed filter must fail closed, never silently widen to all attempts.
  if (attemptIds !== undefined && (
    !Array.isArray(attemptIds) ||
    attemptIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
  )) {
    throw new TypeError('attemptIds must be an array of positive integers');
  }
  const scoped = attemptIds !== undefined;

  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_MINUTES * 60 * 1000);

  // 1. Expired leases: RUNNING with leaseUntil < now -> PENDING.
  //    Collect the capped page first — the reset below makes them ineligible.
  //    Scope the reset to that page: rows beyond it stay RUNNING with an
  //    expired lease, so a later tick can pick them up and re-enqueue them.
  const expiredWhere = { status: 'RUNNING', leaseUntil: { lt: now } };
  if (scoped) expiredWhere.attemptId = { in: attemptIds };
  const expiredRows = await prisma.aiGradingJob.findMany({
    where: expiredWhere,
    select: { id: true, attemptId: true },
    distinct: ['attemptId'],
    take: MAX_BATCH,
  });
  const expiredLeases = await prisma.aiGradingJob.updateMany({
    where: {
      ...expiredWhere,
      id: { in: expiredRows.map((r) => r.id) },
    },
    data: { status: 'PENDING', nextRunAt: now, leaseUntil: null },
  });

  // 2. Exhausted PENDING: tries >= maxTries -> NEEDS_REVIEW(AI_FAILED).
  //    A future nextRunAt is a budget deferral, not an exhausted job: the
  //    worker has already incremented tries but is waiting for the budget to
  //    reset, so escalating here would burn the deferral permanently.
  let attemptFilter;
  if (!scoped) {
    attemptFilter = Prisma.empty;
  } else if (attemptIds.length === 0) {
    attemptFilter = Prisma.sql`AND FALSE`;
  } else {
    attemptFilter = Prisma.sql`AND "attemptId" IN (${Prisma.join(attemptIds)})`;
  }

  const exhausted = await prisma.$executeRaw`
    UPDATE "AiGradingJob"
    SET status = 'NEEDS_REVIEW', reason = 'AI_FAILED', "leaseUntil" = NULL, "updatedAt" = NOW()
    WHERE status = 'PENDING' AND tries >= "maxTries"
      AND ("nextRunAt" IS NULL OR "nextRunAt" <= ${now})
      ${attemptFilter}
  `;

  // 3. Stale PENDING: nextRunAt <= now (or null) and createdAt < staleCutoff -> re-enqueue
  const staleWhere = {
    status: 'PENDING',
    OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
    updatedAt: { lt: staleCutoff },
  };
  if (scoped) staleWhere.attemptId = { in: attemptIds };
  const stalePending = await prisma.aiGradingJob.findMany({
    where: staleWhere,
    select: { attemptId: true },
    distinct: ['attemptId'],
    take: MAX_BATCH,
  });

  // Expired leases and stale PENDING rows both need a fresh enqueue this tick.
  // One attempt may appear in both lists, so dedupe by attemptId.
  const expiredAttemptIds = [...new Set(expiredRows.map((r) => r.attemptId))];
  const reenqueueIds = [...new Set([
    ...expiredAttemptIds,
    ...stalePending.map((r) => r.attemptId),
  ])];

  // Step 2 may have escalated some of these jobs to NEEDS_REVIEW. enqueueAiGrading
  // silently skips non-PENDING jobs, so re-check eligibility before enqueueing
  // instead of reporting a recovery that never happened.
  let reenqueued = 0;
  const enqueuedIds = new Set();
  if (reenqueueIds.length > 0) {
    try {
      const stillPending = await prisma.aiGradingJob.findMany({
        where: { status: 'PENDING', attemptId: { in: reenqueueIds } },
        select: { attemptId: true },
        distinct: ['attemptId'],
      });
      const pendingIds = new Set(stillPending.map((r) => r.attemptId));
      const { enqueueAiGrading } = require('../services/aiGrader/queue');
      for (const attemptId of reenqueueIds) {
        if (!pendingIds.has(attemptId)) continue;
        const count = await enqueueAiGrading(attemptId, { freshJobIds: true });
        if (count > 0) enqueuedIds.add(attemptId);
        reenqueued += count;
      }
    } catch (err) {
      log.warn('ai.reconcile.enqueue_failed', { error: err.message });
    }
  }
  const reenqueuedLeases = expiredAttemptIds.filter((id) => enqueuedIds.has(id)).length;

  // 4. Stored verdict without DONE_APPLIED (FR-7 recovery)
  const unappliedWhere = { status: 'PENDING', verdict: { not: null } };
  if (scoped) unappliedWhere.attemptId = { in: attemptIds };
  const unapplied = await prisma.aiGradingJob.findMany({
    where: unappliedWhere,
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

  // 5. Orphan detection (FR-9): GRADING attempts >15m old with NO live/review jobs.
  //    The SELECT is global, but the alert is a side effect: a scoped tick must
  //    not notify admins about unrelated attempts in a shared DB.
  let orphanAttempts = [];
  if (!scoped) {
    orphanAttempts = await prisma.$queryRaw`
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
  }

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
    reenqueuedLeases,
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
 * A throwing acquire fails closed for this tick but is reported as
 * 'lock-acquire-error', not 'lock-held', so a Redis outage is not mistaken for
 * another instance holding the lock.
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
    try {
      lock = await acquire();
    } catch (err) {
      log.warn('ai.reconcile.lock_acquire_failed', { error: err.message });
      return { skipped: true, reason: 'lock-acquire-error' };
    }
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
