'use strict';

/**
 * budgetTracker.js — Tracks and enforces the daily handwriting conversion budget.
 *
 * Implements Plan §8.1:
 * - HANDWRITING_DAILY_BUDGET cap (default 100 conversions per day).
 * - Keyed by date: hw:budget:YYYY-MM-DD.
 * - Enforces hard stop when daily budget is reached.
 */

const { isRedisEnabled, getRedisClient } = require('../../integrations/redis/redisClient');
const config = require('../../config/env');

const localBudgetMap = new Map();

function getDayKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `hw:budget:${y}-${m}-${d}`;
}

async function checkAndIncrementBudget(maxDaily = config.handwriting.dailyBudget, date = new Date()) {
  const key = getDayKey(date);

  if (isRedisEnabled()) {
    try {
      const client = getRedisClient();
      const current = await client.incr(key);
      if (current === 1) {
        // Set expiry for 48 hours to self-clean
        await client.expire(key, 48 * 3600);
      }
      if (current > maxDaily) {
        return { allowed: false, count: current, maxDaily };
      }
      return { allowed: true, count: current, maxDaily };
    } catch {
      // Redis error fallback to local counter
    }
  }

  const current = (localBudgetMap.get(key) || 0) + 1;
  localBudgetMap.set(key, current);
  if (current > maxDaily) {
    return { allowed: false, count: current, maxDaily };
  }
  return { allowed: true, count: current, maxDaily };
}

async function getDailyCount(date = new Date()) {
  const key = getDayKey(date);
  if (isRedisEnabled()) {
    try {
      const client = getRedisClient();
      const val = await client.get(key);
      return val ? parseInt(val, 10) : 0;
    } catch {
      // Fallback
    }
  }
  return localBudgetMap.get(key) || 0;
}

function resetBudgetForTesting() {
  localBudgetMap.clear();
}

module.exports = {
  checkAndIncrementBudget,
  getDailyCount,
  getDayKey,
  resetBudgetForTesting,
};
