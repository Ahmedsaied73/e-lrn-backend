'use strict';

/**
 * redisClient.js
 * Single module for ALL Redis access — no other file imports `ioredis`
 * directly (mirrors the bunny/supabase isolation rule).
 *
 * Fail-open design: Redis is a cache/accelerator, never a hard dependency.
 * - Commands never buffer while disconnected (`enableOfflineQueue: false`),
 *   so a dead Redis fails fast instead of hanging requests.
 * - The client keeps reconnecting in the background; live traffic falls back
 *   to the source of truth meanwhile (see cache.js).
 * - `error` events are swallowed into sampled logs — an unhandled ioredis
 *   'error' event would crash the process.
 *
 * Future BullMQ use must mint its OWN connections from `createRedisConnection()`
 * (BullMQ needs blocking connections with different retry semantics) — never
 * reuse the shared cache client for workers.
 */

const config = require('../../config/env');

let cached = null;
let connectPromise = null;
let errorLogCount = 0;

function isRedisEnabled() {
  return Boolean(config.redis && config.redis.enabled && config.redis.configured);
}

function createRedisConnection() {
  // Lazy require: keeps `require('./redisClient')` side-effect free when Redis
  // is disabled or ioredis is absent.
  const { Redis } = require('ioredis');
  const client = new Redis(config.redis.url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    retryStrategy(times) {
      return Math.min(times * 100, 3000);
    },
  });
  client.on('error', (err) => {
    // Sampled: connection blips retry every few seconds — don't flood logs,
    // and NEVER log the URL (it carries the token).
    errorLogCount += 1;
    if (errorLogCount <= 3 || errorLogCount % 20 === 0) {
      console.warn(`[WARN] Redis error (#${errorLogCount}): ${err.message}`);
    }
  });
  return client;
}

function getRedis() {
  if (!isRedisEnabled()) return null;
  if (!cached) cached = createRedisConnection();
  return cached;
}

function isRedisReady() {
  return Boolean(cached && cached.status === 'ready');
}

/**
 * Connect in the background (or await it). Never throws: resolves true when
 * ready, false otherwise. Safe to call on every cache operation — connecting
 * state is tracked so concurrent callers share one attempt.
 */
async function ensureConnected(timeoutMs = 5000) {
  const client = getRedis();
  if (!client) return false;
  if (client.status === 'ready') return true;
  if (!connectPromise) {
    connectPromise = (async () => {
      try {
        await Promise.race([
          client.connect(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('connect timeout')), timeoutMs)),
        ]);
        return client.status === 'ready';
      } catch {
        return false;
      } finally {
        connectPromise = null;
      }
    })();
  }
  return connectPromise;
}

async function disconnectRedis() {
  if (connectPromise) await connectPromise.catch(() => {});
  connectPromise = null;
  if (cached) {
    const client = cached;
    cached = null;
    try {
      await client.quit();
    } catch {
      try { client.disconnect(); } catch { /* already gone */ }
    }
  }
}

module.exports = {
  isRedisEnabled,
  getRedis,
  isRedisReady,
  ensureConnected,
  disconnectRedis,
  createRedisConnection,
};
