'use strict';

/**
 * cache.js
 * The ONLY cache API feature code touches. Raw Redis commands stay in here
 * (and redisClient.js) — services call get/set/del/delPrefix/withCache.
 *
 * Rules enforced here, not by callers:
 * - JSON values only; oversize (>256KB) values are never stored.
 * - `null`/`undefined` results are never cached (a cached null is
 *   indistinguishable from a miss, so misses simply recompute).
 * - Malformed entries are treated as a miss and deleted.
 * - Every failure (disabled, disconnected, timeout, error) falls through to
 *   the loader / returns null — Redis never breaks a request.
 * - Keys are server-built strings via buildKey(); max 500 chars.
 */

const { getRedis, ensureConnected } = require('./redisClient');

const KEY_PREFIX = 'v1:';
const MAX_KEY_LENGTH = 500;
const MAX_VALUE_BYTES = 256 * 1024; // 256KB — matches the quiz JSON cap convention
const COMMAND_TIMEOUT_MS = 500;

const counters = {
  hits: 0,
  misses: 0,
  sets: 0,
  invalidations: 0,
  errors: 0,
};

function stats() {
  return { ...counters };
}

function buildKey(...parts) {
  const key = KEY_PREFIX + parts.map((p) => String(p)).join(':');
  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(`Cache key too long (${key.length} chars, max ${MAX_KEY_LENGTH})`);
  }
  return key;
}

/**
 * Short stable hash for free-text key parts (search strings, filters).
 * Bounds key length and charset regardless of user input.
 */
function shortHash(value) {
  const crypto = require('crypto');
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 12);
}

function withTimeout(promise, ms = COMMAND_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('redis command timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Fast-path client: ready now, or kick off background recovery and fail open.
 * Never blocks the request on a (re)connect.
 */
function readyClient() {
  const client = getRedis();
  if (!client) return null;
  if (client.status === 'ready') return client;
  void ensureConnected().catch(() => {});
  return null;
}

async function get(key) {
  const client = readyClient();
  if (!client) return null;
  try {
    const raw = await withTimeout(client.get(key));
    if (raw === null || raw === undefined) {
      counters.misses += 1;
      return null;
    }
    try {
      const value = JSON.parse(raw);
      counters.hits += 1;
      return value;
    } catch {
      counters.errors += 1;
      await client.del(key).catch(() => {});
      return null;
    }
  } catch {
    counters.errors += 1;
    return null;
  }
}

async function set(key, value, ttlSec) {
  if (value === undefined) return false;
  const client = readyClient();
  if (!client) return false;
  let raw;
  try {
    raw = JSON.stringify(value);
  } catch {
    counters.errors += 1;
    return false;
  }
  if (raw === undefined || Buffer.byteLength(raw, 'utf8') > MAX_VALUE_BYTES) return false;
  const ttl = Number.isSafeInteger(ttlSec) && ttlSec > 0 ? ttlSec : 60;
  try {
    await withTimeout(client.set(key, raw, 'EX', ttl));
    counters.sets += 1;
    return true;
  } catch {
    counters.errors += 1;
    return false;
  }
}

async function del(...keys) {
  const flat = keys.flat().filter(Boolean);
  if (flat.length === 0) return 0;
  const client = readyClient();
  if (!client) return 0;
  try {
    const n = await withTimeout(client.del(...flat));
    counters.invalidations += Number(n) || 0;
    return Number(n) || 0;
  } catch {
    counters.errors += 1;
    return 0;
  }
}

/**
 * Delete all keys under a prefix (SCAN + UNLINK, bounded). For invalidation
 * on writes, e.g. delPrefix('v1:courses:').
 */
async function delPrefix(prefix, maxRounds = 100) {
  const client = readyClient();
  if (!client) return 0;
  let removed = 0;
  let cursor = '0';
  try {
    for (let round = 0; round < maxRounds; round++) {
      const [next, keys] = await withTimeout(client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100));
      cursor = next;
      if (keys.length > 0) {
        const n = await withTimeout(client.unlink(...keys));
        removed += Number(n) || 0;
      }
      if (cursor === '0') break;
    }
  } catch {
    counters.errors += 1;
  }
  counters.invalidations += removed;
  return removed;
}

async function withCache(key, ttlSec, loader) {
  // Hit/miss accounting lives in get() — do not double count here.
  let cached;
  try {
    cached = await get(key);
  } catch {
    cached = null;
  }
  if (cached !== null && cached !== undefined) {
    return cached;
  }
  const value = await loader();
  if (value !== undefined && value !== null) {
    await set(key, value, ttlSec);
  }
  return value;
}

module.exports = {
  get,
  set,
  del,
  delPrefix,
  withCache,
  buildKey,
  shortHash,
  stats,
};
