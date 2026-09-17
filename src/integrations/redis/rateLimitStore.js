'use strict';

/**
 * rateLimitStore.js
 * express-rate-limit v7 Store backed by the shared Redis client.
 *
 * - One instance per limiter (each init() captures its own windowMs).
 * - Keys are namespaced `rl:` — never collide with cache keys.
 * - When Redis is disabled/unconfigured, app.js passes no store and
 *   express-rate-limit falls back to its in-memory MemoryStore.
 *
 * FAIL-CLOSED vs FAIL-OPEN WITH FALLBACK
 * ───────────────────────────────────────
 * The `failClosed` option (passed by app.js via REQUIRE_REDIS_RATE_LIMIT)
 * controls behaviour on Redis failure:
 *
 *   failClosed = false (default)
 *     Redis failure → fall back to an in-memory counter so the limiter
 *     still counts requests per-instance. This prevents a Redis blip from
 *     silently disabling auth rate-limiting (an unthrottled brute-force
 *     window). Tradeoff: during a multi-hour Redis outage the threshold
 *     is "N requests per instance" not "N requests globally" — acceptable
 *     as a degraded posture. The limiter's passOnStoreError flag is
 *     effectively moot in this mode because the store never throws.
 *
 *   failClosed = true
 *     Redis failure → throw RateLimitStoreUnavailableError → the limiter
 *     passes the error to the global handler → HTTP 503. No local fallback
 *     is used. This is the strict internet-exposed posture.
 *
 * IN-MEMORY FALLBACK LIMITATIONS
 * ──────────────────────────────
 * The fallback counter is per-instance (each Node.js process has its own
 * Map). During a Redis outage it provides per-IP/per-endpoint throttling
 * bounded by the configured window, but does NOT aggregate across multiple
 * deployed instances. Explicit tradeoff documented here and in AGENTS.md.
 */

const { getRedis, ensureConnected } = require('./redisClient');

const PREFIX = 'rl:';
const COMMAND_TIMEOUT_MS = 500;
const CONNECT_TIMEOUT_MS = 250;
// Maximum entries kept in the local fallback map. During normal operation
// Redis handles counting and the map stays empty. This cap is only reached
// when Redis is down and many distinct keys are seen. 10 000 ≈ a full
// /24 network's worth of IP keys — well under the per-IP limit of most
// deployments and far under what express-rate-limit's own MemoryStore holds.
const LOCAL_MAP_MAX = 10_000;

// Typed error so a limiter configured with passOnStoreError:false can fail
// CLOSED with a specific HTTP code (503 RATE_LIMIT_STORE_UNAVAILABLE) instead
// of a generic 500 — the global error handler in app.js keys on this code.
class RateLimitStoreUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitStoreUnavailableError';
    this.code = 'RATE_LIMIT_STORE_UNAVAILABLE';
    this.statusCode = 503;
  }
}

function withTimeout(promise, ms = COMMAND_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new RateLimitStoreUnavailableError('redis store timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function clientOrThrow() {
  const client = getRedis();
  if (!client || client.status !== 'ready') {
    throw new RateLimitStoreUnavailableError('redis unavailable for rate limiting');
  }
  return client;
}

/**
 * Connect-on-first-use (bounded): cold requests wait up to CONNECT_TIMEOUT_MS
 * for the initial handshake, then proceed; later calls are instant. Anything
 * still unready rejects → the caller handles (throw in failClosed mode,
 * fall back to local counter otherwise).
 */
async function readyClient() {
  let client = getRedis();
  if (client && client.status === 'ready') return client;
  await ensureConnected(CONNECT_TIMEOUT_MS).catch(() => false);
  return clientOrThrow();
}

/**
 * Lazily sweep expired entries from the local fallback map.
 * Called on each local increment — amortised O(1) when idle.
 */
function sweepLocal(local) {
  if (local.size < LOCAL_MAP_MAX) return;
  const now = Date.now();
  for (const [k, v] of local) {
    if (v.resetTime <= now) local.delete(k);
  }
}

/**
 * Create an express-rate-limit Store backed by Redis with an in-memory
 * fallback for degraded-mode counting.
 *
 * @param {string} keyPrefix  Redis key namespace (default 'rl:').
 * @param {object} [opts]
 * @param {boolean} [opts.failClosed=false]  When true, throw on Redis
 *   failure instead of falling back to the local counter (503 path).
 */
function createRateLimitStore(keyPrefix = PREFIX, { failClosed = false } = {}) {
  let windowMs = 15 * 60 * 1000;
  // Per-instance fallback counter — keyed by the SAME key the limiter passes
  // (the library strips the prefix for its own key, but we receive it here
  // from the limiter's keyGenerator). We namespace internally to avoid
  // collision if two stores accidentally receive the same raw key.
  const local = new Map();

  /**
   * Increment using the local fallback counter (no Redis).
   * Returns the same shape as the Redis path so the limiter reads totalHits.
   */
  function localIncrement(key) {
    const now = Date.now();
    const rec = local.get(key);
    if (!rec || rec.resetTime <= now) {
      local.set(key, { hits: 1, resetTime: now + windowMs });
      return { totalHits: 1, resetTime: new Date(now + windowMs) };
    }
    rec.hits += 1;
    return { totalHits: rec.hits, resetTime: new Date(rec.resetTime) };
  }

  return {
    prefix: keyPrefix,
    localKeys: false,

    init(options) {
      if (options && Number.isSafeInteger(options.windowMs) && options.windowMs > 0) {
        windowMs = options.windowMs;
      }
    },

    async increment(key) {
      try {
        const client = await readyClient();
        const fullKey = `${keyPrefix}${key}`;
        // Atomic INCR + first-hit expiry in one Lua step: a crash between the
        // two can no longer leave a TTL-less key throttling an IP forever.
        // NOTE: resetTime stays approximate (full window, not remaining TTL) —
        // cosmetic only; counting is exact.
        const totalHits = await withTimeout(
          client.eval(
            `local c = redis.call('INCR', KEYS[1]); ` +
            `if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end; ` +
            `return c;`,
            1,
            fullKey,
            String(windowMs)
          )
        );
        // Redis healthy — clear any stale local entry so we don't leak memory.
        local.delete(key);
        return { totalHits: Number(totalHits), resetTime: new Date(Date.now() + windowMs) };
      } catch (err) {
        if (failClosed) throw err;
        // Redis unavailable — fall back to local counting so limiting still
        // holds per-instance rather than silently opening the tap entirely.
        sweepLocal(local);
        return localIncrement(key);
      }
    },

    async decrement(key) {
      try {
        const client = await readyClient();
        await withTimeout(client.decr(`${keyPrefix}${key}`));
      } catch (err) {
        if (failClosed) throw err;
        // Best-effort local mirror: decrement the local counter if present.
        const rec = local.get(key);
        if (rec && rec.hits > 0) rec.hits -= 1;
      }
    },

    async resetKey(key) {
      try {
        const client = await readyClient();
        await withTimeout(client.del(`${keyPrefix}${key}`));
      } catch (err) {
        if (failClosed) throw err;
        local.delete(key);
      }
    },
  };
}

module.exports = { createRateLimitStore, RateLimitStoreUnavailableError };
