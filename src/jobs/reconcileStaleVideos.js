'use strict';

/**
 * Stale Video Reconciliation Job
 *
 * Catches videos stuck in PROCESSING if a Bunny webhook was never delivered
 * (e.g. dropped delivery, dev tunnel was down, transient Bunny issue).
 *
 * Schedule: every 10 minutes
 * Logic: find BunnyVideo rows where status = PROCESSING and updatedAt > 30 minutes ago,
 *        poll Bunny GET /library/{id}/videos/{videoId} for each, apply the current
 *        remote status to the local record.
 *
 * Why node-cron: no job runner (Bull/Agenda) exists in this repo. node-cron is the
 * minimal choice that avoids a heavy infrastructure dependency. Future-proof note:
 * if BullMQ or similar is ever added, move this job there and delete this file.
 *
 * Consistency model note (documented per spec requirement):
 * - This system is AP (available + partition tolerant) during the Bunny encoding window.
 * - Eventual consistency is achieved by: webhook (primary) + reconciliation (secondary).
 * - If both fail for a video (e.g. Bunny never returns a status), the video stays in
 *   PROCESSING until manually inspected. An outbox/retry-queue pattern would be the
 *   next step if scale demands stricter guarantees.
 */

const cron = require('node-cron');
const bunnyVideoService = require('../services/bunnyVideoService');
const bunnyClient = require('../integrations/bunny/bunnyStreamClient');

const STALE_MINUTES = 30;

// Per-run limits: process at most MAX_BATCH stale videos at a time, with up to
// CONCURRENCY parallel Bunny GETs. Keeps the safety-net job bounded even if a
// batch of uploads stalls while the webhook is down.
const MAX_BATCH = 50;
const CONCURRENCY = 4;

// Overlap guard — a slow run (many remote polls) must not stack on top of the
// next 10-minute tick.
let isRunning = false;

const log = {
  info: (event, ctx = {}) => console.log(`[INFO] ${event}`, JSON.stringify(ctx)),
  warn: (event, ctx = {}) => console.warn(`[WARN] ${event}`, JSON.stringify(ctx)),
  error: (event, ctx = {}) => console.error(`[ERROR] ${event}`, JSON.stringify(ctx)),
};

// Minimal bounded-pool helper: maps `items` through `fn`, running at most
// `limit` promises concurrently. Per-item rejections are isolated by `fn`'s
// caller (reconcileStaleVideos wraps each poll in its own try/catch).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  };

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/**
 * Main reconciliation function.
 * Can be called directly for testing/manual runs, or scheduled via cron.
 */
async function reconcileStaleVideos() {
  if (isRunning) {
    log.warn('video.reconcile.skip_overlap');
    return;
  }
  isRunning = true;

  try {
    let staleVideos;

    try {
      staleVideos = await bunnyVideoService.findStaleProcessing(STALE_MINUTES, MAX_BATCH);
    } catch (err) {
      log.error('video.reconcile.db_read_failed', { error: err.message });
      return;
    }

    if (staleVideos.length === 0) {
      return; // Nothing to reconcile — don't log (noisy at 10-min intervals)
    }

    log.info('video.reconcile.started', { count: staleVideos.length, staleMinutes: STALE_MINUTES });

    const reconcileOne = async (video) => {
      try {
        const remote = await bunnyClient.getVideo(video.bunnyVideoId);
        const remoteBunnyStatus = remote.status; // numeric Bunny status

        const domainStatus = bunnyVideoService.BUNNY_STATUS_MAP[remoteBunnyStatus];

        if (!domainStatus) {
          // Status is in the ignored range (6-10) — not actionable
          log.info('video.reconcile.status_ignored', {
            videoId: video.id,
            bunnyVideoId: video.bunnyVideoId,
            remoteBunnyStatus,
          });
          return;
        }

        if (domainStatus !== video.status) {
          // Status differs — apply it (applyBunnyStatus handles idempotency internally)
          await bunnyVideoService.applyBunnyStatus(video.bunnyVideoId, remoteBunnyStatus);

          log.info('video.reconciled', {
            videoId: video.id,
            courseId: video.courseId,
            bunnyVideoId: video.bunnyVideoId,
            from: video.status,
            to: domainStatus,
          });
        }
      } catch (err) {
        // Per-video failure is isolated — other videos in the batch still get processed
        log.error('video.reconcile.failed', {
          videoId: video.id,
          bunnyVideoId: video.bunnyVideoId,
          error: err.message,
        });
      }
    };

    await mapWithConcurrency(staleVideos, CONCURRENCY, reconcileOne);

    log.info('video.reconcile.completed', { count: staleVideos.length });
  } finally {
    isRunning = false;
  }
}

/**
 * Start the reconciliation cron job.
 * Called once from app.js during startup.
 *
 * Schedule: '* /10 * * * *' = every 10 minutes
 * This is intentionally lenient — webhook is the primary delivery mechanism.
 * The job is a safety net, not a polling replacement.
 */
function startReconciliationJob() {
  // Run every 10 minutes
  cron.schedule('*/10 * * * *', async () => {
    try {
      await reconcileStaleVideos();
    } catch (err) {
      // Top-level catch: don't let an unhandled error crash the process
      log.error('video.reconcile.unhandled_error', { error: err.message });
    }
  });

  log.info('video.reconcile.job_started', {
    schedule: 'every 10 minutes',
    staleThreshold: `${STALE_MINUTES} minutes`,
  });
}

module.exports = { startReconciliationJob, reconcileStaleVideos };
