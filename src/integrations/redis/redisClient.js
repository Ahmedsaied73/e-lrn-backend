'use strict';

/**
 * redisClient.js
 * Single module for ALL Redis access — no other file imports `ioredis`
 * directly (mirrors the bunny/supabase isolation rule).
 *
 * Fail-open design: Redis is a cache/accelerator, never a hard dependency.
 * - Commands never buffer while disconnected (`enableOfflineQueue: false`),
 *   so a dead Redis fails fast instead of hanging requests.
 * - The client reconnects with capped exponential backoff + jitter; after
 *   REDIS_MAX_RECONNECT_ATTEMPTS (default 50) it gives up and the process
 *   stays in fail-open mode (traffic falls back to the source of truth —
 *   see cache.js). A later `ensureConnected()` re-arms the retry budget,
 *   but only after REDIS_RECONNECT_COOLDOWN_MS (default 60s) so a dead
 *   Redis isn't hammered by per-request re-arm cycles.
 * - BullMQ connections (maxRetriesPerRequest: null) are exempt from the
 *   give-up: a dead worker/queue is worse than endless reconnects.
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

// Read here (not env.js): this module is the single owner of Redis access.
function envPositiveInt(rawValue, fallback) {
  const n = Number(rawValue);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}
const MAX_RECONNECT_ATTEMPTS = envPositiveInt(process.env.REDIS_MAX_RECONNECT_ATTEMPTS, 50);
const RECONNECT_COOLDOWN_MS = envPositiveInt(process.env.REDIS_RECONNECT_COOLDOWN_MS, 60000);

// Timestamp of the last give-up — scopes the cooldown to the shared client's
// episode. BullMQ connections never give up, so they never touch this.
let lastGiveUpAt = 0;

function isRedisEnabled() {
  return Boolean(config.redis && config.redis.enabled && config.redis.configured);
}

function createRedisConnection(overrides = {}) {
  // Lazy require: keeps `require('./redisClient')` side-effect free when Redis
  // is disabled or ioredis is absent.
  const { Redis } = require('ioredis');
  // BullMQ callers identify themselves via maxRetriesPerRequest: null (blocking
  // semantics) — those connections must NEVER give up reconnecting, or a Redis
  // blip would silently kill the queue/worker for the rest of the process.
  const isBullMq = overrides.maxRetriesPerRequest === null;
  const client = new Redis(config.redis.url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    // TCP keepalive so idle connections (BullMQ queue conn, cron locks between
    // 10-min ticks) survive provider-side idle eviction.
    keepAlive: 10000,
    retryStrategy(times) {
      if (!isBullMq && times > MAX_RECONNECT_ATTEMPTS) {
        // One clear line, then stop: a permanently-dead Redis flips the
        // process to fail-open mode instead of retrying (and logging) forever.
        lastGiveUpAt = Date.now();
        console.error(`[ERROR] Redis unreachable after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts — giving up (fail-open). A later cache access re-arms retries after a ${RECONNECT_COOLDOWN_MS}ms cooldown.`);
        return null;
      }
      // Exponential backoff capped at 30s with 50% jitter (avoids a reconnect
      // thundering herd after a provider-wide outage).
      const backoff = Math.min(100 * 2 ** (times - 1), 30000);
      return Math.round(backoff / 2 + Math.random() * (backoff / 2));
    },
    // reconnectOnError intentionally left at the ioredis default (reconnect
    // only on READONLY failover errors): the attempt cap above already bounds
    // any error-driven reconnect loop, and BullMQ needs that default to
    // survive managed-Redis failovers.
    // Callers with different semantics override here — e.g. BullMQ mandates
    // maxRetriesPerRequest: null on its connections.
    ...overrides,
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
  // Give-up cooldown: after the retry budget is exhausted the shared client
  // sits in 'end' — don't re-arm a fresh retry cycle until the cooldown
  // elapses, then re-arm normally (self-healing preserved).
  if (client.status === 'end' && Date.now() - lastGiveUpAt < RECONNECT_COOLDOWN_MS) return false;
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
