'use strict';

/**
 * pruneAgentMemories.js
 * Retention job for agent memory rows.
 *
 * Cloned from pruneAgentConversations.js deliberately — same cron shape, same
 * distributed lock, same fail-open policy — so every background job in this service
 * behaves identically under a Redis outage and under multiple instances, and so a
 * reader who knows one job knows this one.
 *
 * WHY DAILY: the window is measured in days and the data is a remembered fact, not
 * a cache. Hourly would add load for no accuracy gain; the only cost of a coarser
 * tick is that an expired row can outlive its window by up to one interval.
 */

const cron = require('node-cron');
const config = require('../config/env');
const prisma = require('../config/db');
const { pruneExpiredMemories } = require('../services/agent/memoryService');
const { acquireLock, releaseLock } = require('../integrations/redis/distributedLock');

const LOCK_KEY = 'lock:prune-agent-memories';
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
async function pruneAgentMemories() {
  if (isRunning) {
    log.warn('agent.memory.retention.skip_overlap');
    return { deleted: 0, remaining: null, disabled: false };
  }

  let lock;
  try {
    lock = await acquireLock(LOCK_KEY, LOCK_TTL_SECONDS);
  } catch (err) {
    // Commitment boundary: a Redis hiccup must not disable retention. The
    // process-local guard below is all we still have, which is acceptable — the
    // worst case of a doubled sweep is deleting a batch twice.
    log.warn('agent.memory.retention.lock_failed', { error: err.message });
    lock = { acquired: true, token: null };
  }
  if (!lock.acquired) {
    log.warn('agent.memory.retention.skip_lock_held');
    return { deleted: 0, remaining: null, disabled: false };
  }

  isRunning = true;
  const retentionDays = config.aiAgent.memoryRetentionDays;

  try {
    const result = await pruneExpiredMemories({ prisma, retentionDays });

    if (result.disabled) {
      log.warn('agent.memory.retention.disabled');
      return result;
    }
    if (result.deleted > 0) {
      log.info('agent.memory.retention.pruned', {
        deleted: result.deleted,
        retentionDays,
        remaining: result.remaining,
      });
    } else if (result.remaining > 0) {
      // A still-positive `remaining` is normal (the batch cap), not an error — the
      // next daily tick continues. Only surface it so the window is observable.
      log.info('agent.memory.retention.backlog', { remaining: result.remaining, retentionDays });
    }

    return result;
  } catch (err) {
    // Retention failing must never crash the process; the window simply slips a day.
    log.error('agent.memory.retention.failed', { error: err.message });
    return { deleted: 0, remaining: null, disabled: false };
  } finally {
    isRunning = false;
    try {
      await releaseLock(LOCK_KEY, lock.token);
    } catch (err) {
      log.warn('agent.memory.retention.lock_release_failed', { error: err.message });
    }
  }
}

/** Start the daily sweep. Called once from app.js during startup, beside its twin. */
function startMemoryRetentionJob() {
  // 03:47 rather than 03:17 (conversations) and not on the hour either: three daily
  // ticks must not stack on top of each other.
  const task = cron.schedule('47 3 * * *', async () => {
    // Top-level catch: an unhandled rejection here becomes an unhandledRejection
    // in the app process. pruneAgentMemories already catches; this is belt
    // and braces so a future edit cannot take the server down at 03:47.
    try {
      await pruneAgentMemories();
    } catch (err) {
      log.error('agent.memory.retention.unhandled_error', { error: err.message });
    }
  });

  log.info('agent.memory.retention.job_started', {
    schedule: 'daily at 03:47',
    retentionDays: config.aiAgent.memoryRetentionDays,
  });
  return task;
}

function stopMemoryRetentionJob(task) {
  try {
    if (task && task.destroy) task.destroy();
  } catch (err) {
    log.warn('agent.memory.retention.job_stop_failed', { error: err.message });
  }
}

module.exports = { startMemoryRetentionJob, stopMemoryRetentionJob, pruneAgentMemories };