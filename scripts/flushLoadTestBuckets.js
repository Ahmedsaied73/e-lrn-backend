'use strict';

/**
 * flushLoadTestBuckets.js — clear stale rate-limit buckets between k6 stages.
 *
 * Lesson (audit): leftover `rl:*` counters from a previous run cause PHANTOM
 * 429s at the start of a new run. Run this between test stages:
 *   node scripts/flushLoadTestBuckets.js
 *
 * Uses the app's real Redis client (src/integrations/redis/redisClient.js)
 * with its fail-open pattern: if Redis is disabled/unavailable, print a skip
 * message and exit 0.
 */

const redis = require('../src/integrations/redis/redisClient');

async function main() {
  if (!redis.isRedisEnabled()) {
    console.log('[flush] Redis is disabled (config.redis.enabled/configured=false) — no rl:* buckets to flush. Skipping.');
    return;
  }

  const ready = await redis.ensureConnected(5000);
  if (!ready) {
    console.log('[flush] Redis unreachable — skipping bucket flush (fail-open).');
    return;
  }

  const client = redis.getRedis();
  let deleted = 0;
  const batch = [];

  for await (const key of client.scanIterator({ MATCH: 'rl:*', COUNT: 500 })) {
    batch.push(key);
    if (batch.length >= 500) {
      deleted += await client.unlink(...batch) || 0;
      batch.length = 0;
    }
  }
  if (batch.length) {
    deleted += await client.unlink(...batch) || 0;
  }

  console.log(`[flush] Deleted ${deleted} rate-limit bucket key(s) matching rl:*.`);
}

main()
  .catch((e) => {
    // Never fail a stage boundary because of flush problems.
    console.warn(`[flush] Failed (${e.message}) — continuing (fail-open).`);
  })
  .finally(async () => {
    try { await redis.disconnectRedis(); } catch { /* ignore */ }
  });
