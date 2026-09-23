'use strict';

/**
 * Stale Payment Reconciliation Job (D11 backstop).
 *
 * Catches payments stuck in PENDING when a Paymob webhook never arrived
 * (dropped delivery, tunnel down, Paymob outage) — the same failure mode the
 * Bunny job covers for videos.
 *
 * Schedule: every 10 minutes. Logic:
 *   1. PENDING payments older than STALE_MINUTES whose hosted session has
 *      outlived its expiry → lazy EXPIRED flip (no gateway call needed).
 *   2. Still-live PENDING rows → ask the provider for the real transaction
 *      state and apply it through the SAME event pipeline the webhook uses
 *      (idempotent by construction — it is a CAS).
 *
 * Mirrors src/jobs/reconcileStaleVideos.js: node-cron, a distributed Redis
 * lock (one instance per window), an overlap guard, bounded batches.
 *
 * Feature-gated: only started when payments are enabled; lazy-requires the
 * payments service so deleting that folder cannot break boot.
 */

const cron = require('node-cron');
const prisma = require('../config/db');
const config = require('../config/env');
const { acquireLock, releaseLock } = require('../integrations/redis/distributedLock');

const STALE_MINUTES = 30;      // only consider rows older than this
const MAX_BATCH = 50;          // bounded work per run
const LOCK_KEY = 'lock:reconcile-payments';
const LOCK_TTL_SECONDS = 300;  // 5 min — auto-expires if a holder crashes

let isRunning = false;

const log = {
  info: (event, ctx = {}) => console.log(`[INFO] ${event}`, JSON.stringify(ctx)),
  warn: (event, ctx = {}) => console.warn(`[WARN] ${event}`, JSON.stringify(ctx)),
  error: (event, ctx = {}) => console.error(`[ERROR] ${event}`, JSON.stringify(ctx)),
};

/** Reconciliation is only meaningful (and safe) with payments on. */
function paymentsOn() {
  return Boolean(config.features && config.features.payments && config.paymob && config.paymob.enabled);
}

/**
 * Main reconciliation. Safe to call directly (tests, manual runs) or via cron.
 * @returns {Promise<{expired:number, checked:number, settled:number, skipped:boolean}>}
 */
async function reconcilePayments() {
  if (!paymentsOn()) return { expired: 0, checked: 0, settled: 0, skipped: true };
  if (isRunning) {
    log.warn('payment.reconcile.skip_overlap');
    return { expired: 0, checked: 0, settled: 0, skipped: true };
  }
  let lock;
  try {
    lock = await acquireLock(LOCK_KEY, LOCK_TTL_SECONDS);
  } catch (err) {
    // Commitment boundary: a Redis hiccup must never disable the safety net.
    log.warn('payment.reconcile.lock_failed', { error: err.message });
    lock = { acquired: true, token: null }; // fail-open: process-local guard only
  }
  if (!lock.acquired) {
    log.warn('payment.reconcile.skip_lock_held');
    return { expired: 0, checked: 0, settled: 0, skipped: true };
  }
  isRunning = true;

  try {
    const paymentService = require('../services/payments/paymentService');
    const { getProvider } = require('../services/payments/providers/index');

    const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000);
    let stale;
    try {
      stale = await prisma.payment.findMany({
        where: { status: 'PENDING', createdAt: { lt: cutoff } },
        orderBy: { createdAt: 'asc' },
        take: MAX_BATCH,
        select: { id: true, userId: true, providerReference: true, providerTxnId: true, intentionExpiresAt: true },
      });
    } catch (err) {
      log.error('payment.reconcile.db_read_failed', { error: err.message });
      return { expired: 0, checked: 0, settled: 0, skipped: false };
    }

    const now = new Date();
    let expired = 0;
    let checked = 0;
    let settled = 0;

    for (const row of stale) {
      // 1. Session outlived its expiry with no callback → EXPIRED. (The read
      //    paths flip lazily too; doing it here keeps the admin list honest
      //    without anyone opening a page.)
      if (row.intentionExpiresAt && row.intentionExpiresAt <= now) {
        const flipped = await prisma.payment.updateMany({
          where: { id: row.id, status: 'PENDING' },
          data: { status: 'EXPIRED', failureReason: 'Checkout session expired before payment.' },
        });
        if (flipped.count > 0) {
          expired += 1;
          // This direct CAS bypasses paymentService.expireIfStale, so drop
          // the cached status poll here too (R8). Never throws.
          await paymentService.invalidateStatusCache(row);
        }
        continue;
      }

      // 2. Still inside its window: ask the provider what actually happened —
      //    only when we hold a handle to ask about.
      if (!row.providerReference && !row.providerTxnId) continue;
      checked += 1;
      try {
        const remote = await getProvider('paymob').fetchTransaction({
          providerTxnId: row.providerTxnId,
          providerOrderId: row.providerReference,
        });
        const event = getProvider('paymob').normalizeEvent(remote, { expectedReference: row.providerReference });
        // SAME pipeline as the webhook: amount proof + CAS (idempotent).
        const result = await paymentService.processProviderEvent({ event });
        if (result && (result.reason === 'completed' || result.reason === 'payment_failed')) settled += 1;
      } catch (err) {
        // Per-row isolation: one unreachable lookup must not abort the batch.
        log.warn('payment.reconcile.lookup_failed', {
          paymentId: row.id,
          error: String((err && err.message) || err).slice(0, 200),
        });
      }
    }

    if (expired || settled) {
      log.info('payment.reconcile.summary', { candidates: stale.length, expired, checked, settled });
    }
    return { expired, checked, settled, skipped: false };
  } finally {
    isRunning = false;
    try {
      await releaseLock(LOCK_KEY, lock.token);
    } catch (err) {
      log.warn('payment.reconcile.lock_release_failed', { error: err.message });
    }
  }
}

/** Schedule the job (every 10 minutes). Returns the cron task. */
function startPaymentReconciliationJob() {
  return cron.schedule('*/10 * * * *', async () => {
    try {
      await reconcilePayments();
    } catch (err) {
      log.error('payment.reconcile.unhandled', { error: String((err && err.message) || err).slice(0, 200) });
    }
  });
}

function stopPaymentReconciliationJob(task) {
  if (task && typeof task.stop === 'function') task.stop();
}

module.exports = { startPaymentReconciliationJob, stopPaymentReconciliationJob, reconcilePayments };