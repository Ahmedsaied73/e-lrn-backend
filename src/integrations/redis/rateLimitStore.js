'use strict';

/**
 * rateLimitStore.js
 * express-rate-limit v7 Store backed by the shared Redis client.
 *
 * - One instance per limiter (each init() captures its own windowMs).
 * - Keys are namespaced `rl:` — never collide with cache keys.
 * - Any Redis failure rejects, and the limiter is configured with
 *   `passOnStoreError: true`, so a dead Redis allows traffic (fail-open)
 *   instead of 500ing every request. The library logs the store error.
 * - When Redis is disabled/unconfigured, app.js passes no store and
 *   express-rate-limit falls back to its in-memory MemoryStore.
 */

const { getRedis, ensureConnected } = require('./redisClient');

const PREFIX = 'rl:';
const COMMAND_TIMEOUT_MS = 500;
const CONNECT_TIMEOUT_MS = 1000;

function withTimeout(promise, ms = COMMAND_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('redis store timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function clientOrThrow() {
  const client = getRedis();
  if (!client || client.status !== 'ready') {
    throw new Error('redis unavailable for rate limiting');
  }
  return client;
}

/**
 * Connect-on-first-use (bounded): cold requests wait up to CONNECT_TIMEOUT_MS
 * for the initial handshake, then proceed; later calls are instant. Anything
 * still unready rejects → the limiter's passOnStoreError allows the request.
 */
async function readyClient() {
  let client = getRedis();
  if (client && client.status === 'ready') return client;
  await ensureConnected(CONNECT_TIMEOUT_MS).catch(() => false);
  return clientOrThrow();
}

function createRateLimitStore() {
  let windowMs = 15 * 60 * 1000;

  return {
    prefix: PREFIX,
    localKeys: false,

    init(options) {
      if (options && Number.isSafeInteger(options.windowMs) && options.windowMs > 0) {
        windowMs = options.windowMs;
      }
    },

    async increment(key) {
      const client = await readyClient();
      const fullKey = `${PREFIX}${key}`;
      const totalHits = await withTimeout(client.incr(fullKey));
      if (Number(totalHits) === 1) {
        await withTimeout(client.pexpire(fullKey, windowMs));
      }
      return { totalHits: Number(totalHits), resetTime: new Date(Date.now() + windowMs) };
    },

    async decrement(key) {
      const client = await readyClient();
      await withTimeout(client.decr(`${PREFIX}${key}`));
    },

    async resetKey(key) {
      const client = await readyClient();
      await withTimeout(client.del(`${PREFIX}${key}`));
    },
  };
}

module.exports = { createRateLimitStore };
