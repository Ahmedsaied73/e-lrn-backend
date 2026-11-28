'use strict';

const cache = require('../../integrations/redis/cache');

const FLAG_TTL_SEC = 300;
const HUD_TTL_SEC = 60;
const SUMMARY_TTL_SEC = 30;

function flagKey(tenantId) {
  return cache.buildKey('gamify', 'flag', tenantId);
}

function hudKey(tenantId, studentId) {
  return cache.buildKey('gamify', 'hud', tenantId, studentId);
}

function summaryKey(tenantId, studentId) {
  return cache.buildKey('gamify', 'summary', tenantId, studentId);
}

async function invalidateFlagCache(tenantId) {
  try {
    await cache.del(flagKey(tenantId));
  } catch {
    // Fail-open: stale flag heals on TTL.
  }
}

async function invalidateStudentCaches(tenantId, studentId) {
  try {
    await cache.del(hudKey(tenantId, studentId), summaryKey(tenantId, studentId));
  } catch {
    // Fail-open: stale HUD/summary heals on TTL.
  }
}

module.exports = {
  FLAG_TTL_SEC,
  HUD_TTL_SEC,
  SUMMARY_TTL_SEC,
  flagKey,
  hudKey,
  summaryKey,
  invalidateFlagCache,
  invalidateStudentCaches,
};
