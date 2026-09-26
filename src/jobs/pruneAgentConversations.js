'use strict';

/**
 * pruneAgentConversations.js
 * Retention job for agent transcripts.
 *
 * AI_AGENT_CONVERSATION_RETENTION_DAYS was resolved and clamped in config but read
 * by nothing, so agent conversations accumulated forever. This closes that: a daily
 * sweep deletes conversations untouched for longer than the window, and Prisma's
 * onDelete: Cascade takes the messages and approvals with them.
 *
 * Mirrors src/jobs/reconcileStaleVideos.js deliberately — same cron shape, same
 * distributed lock, same fail-open policy — so every background job in this service
 * behaves identically under a Redis outage and under multiple instances.
 *
 * WHY DAILY: the window is measured in days and the data is a transcript, not a
 * cache. Hourly would add load for no accuracy gain; the only cost of a coarser
 * tick is that an expired row can outlive its window by up to one interval.
 */

const cron = require('node-cron');
const config = require('../config/env');
const prisma = require('../config/db');
const { pruneExpiredConversations } = require('../services/agent/conversationService');
const { acquireLock, releaseLock } = require('../integrations/redis/distributedLock');

const LOCK_KEY = 'lock:prune-agent-conversations';
const LOCK_TTL_SECONDS = 300; // 5 min — longer than any realistic run.

let isRunning = false;

const log = {
  info: (event, ctx = {}) => console.log(`[INFO] ${event}`, JSON.stringify(ctx)),
  warn: (event, ctx = {}) => console.warn(`[WARN] ${event}`, JSON.stringify(ctx)),
  error: (event, ctx = {}) => console.error(`[ERROR] ${event}`, JSON.stringify(ctx)),
};

/**
 * One sweep. Exported so it can be run directly (tests, a manual cleanup) without
 * waiting for the schedule.
 * @returns {Promise<{ deleted: number, remaining: number|null, disabled: boolean }>}
 */
async function pruneAgentConversations() {
  if (isRunning) {
    log.warn('agent.retention.skip_overlap');
    return { deleted: 0, remaining: null, disabled: false };
  }

  let lock;
  try {
    lock = await acquireLock(LOCK_KEY, LOCK_TTL_SECONDS);
  } catch (err) {
    // Commitment boundary: a Redis hiccup must not disable retention. The
    // process-local guard below is all we still have, which is acceptable — the
    // worst case of a doubled sweep is deleting a batch twice.
    log.warn('agent.retention.lock_failed', { error: err.message });
    lock = { acquired: true, token: null };
  }
  if (!lock.acquired) {
    log.warn('agent.retention.skip_lock_held');
    return { deleted: 0, remaining: null, disabled: false };
  }

  isRunning = true;
  const retentionDays = config.aiAgent.conversationRetentionDays;

  try {
    const result = await pruneExpiredConversations({ prisma, retentionDays });

    if (result.disabled) {
      log.warn('agent.retention.disabled');
      return result;
    }
    if (result.deleted > 0) {
      log.info('agent.retention.pruned', {
        deleted: result.deleted,
        retentionDays,
        remaining: result.remaining,
      });
    } else if (result.remaining > 0) {
      // A still-positive `remaining` is normal (the batch cap), not an error — the
      // next daily tick continues. Only surface it so the window is observable.
      log.info('agent.retention.backlog', { remaining: result.remaining, retentionDays });
    }

    return result;
  } catch (err) {
    // Retention failing must never crash the process; the window simply slips a day.
    log.error('agent.retention.failed', { error: err.message });
    return { deleted: 0, remaining: null, disabled: false };
  } finally {
    isRunning = false;
    try {
      await releaseLock(LOCK_KEY, lock.token);
    } catch (err) {
      log.warn('agent.retention.lock_release_failed', { error: err.message });
    }
  }
}

/** Start the daily sweep. Called once from app.js during startup. */
function startRetentionJob() {
  // 03:17 rather than 03:00: every other job in this service already runs on the
  // hour, and an off-minute keeps the daily tick from stacking on top of them.
  const task = cron.schedule('17 3 * * *', async () => {
    // Top-level catch: an unhandled rejection here becomes an unhandledRejection
    // in the app process. pruneAgentConversations already catches; this is belt
    // and braces so a future edit cannot take the server down at 03:17.
    try {
      await pruneAgentConversations();
    } catch (err) {
      log.error('agent.retention.unhandled_error', { error: err.message });
    }
  });

  log.info('agent.retention.job_started', {
    schedule: 'daily at 03:17',
    retentionDays: config.aiAgent.conversationRetentionDays,
  });
  return task;
}

function stopRetentionJob(task) {
  try {
    if (task && task.destroy) task.destroy();
  } catch (err) {
    log.warn('agent.retention.job_stop_failed', { error: err.message });
  }
}

module.exports = { startRetentionJob, stopRetentionJob, pruneAgentConversations };