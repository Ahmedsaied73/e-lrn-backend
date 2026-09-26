'use strict';

/**
 * toolCache.js — the per-PROCESS micro-cache for read tools (Phase 4.5-A2).
 *
 * WHY THIS EXISTS (and why it is not a second Redis):
 *   The shared cache layer (src/integrations/redis/cache.js) is deliberately
 *   fail-open: when Redis cannot be reached — which is what this process is
 *   currently logging (read ECONNRESET) — every cached read falls through to the
 *   loader, so every admin question pays its full set of DB round trips again.
 *   A bounded in-process TTL map absorbs that: one DB query serves every question
 *   asked within the TTL, even while Redis is flapping.
 *
 *   This is NOT a replacement for Redis. Redis stays the shared, cross-process
 *   layer; this cache is per-process, best-effort and strictly SHORTER-lived
 *   (TTL = min(def.cacheTtlSeconds, MAX_TTL_SECONDS)), so it can never serve
 *   anything staler than the definition already agreed to serve.
 *
 * SAFETY PROPERTIES (each one is deliberate):
 *   - READS ONLY. Actions declare cacheTtlSeconds === 0 and are refused by the
 *     boot validation anyway; wrapReadDefinition refuses anything that is not a
 *     read with a positive TTL.
 *   - NEVER WRAPS AROUND _kit. Only `def.run` is wrapped, i.e. the DB call.
 *     Argument validation, the row cap, the approval gate, the audit row and PII
 *     redaction still happen in _kit.execute() on every call, cached or not: the
 *     cached value is the RAW payload, re-finalized (and re-redacted) each time.
 *     No payload leaves through a path _kit does not control.
 *   - NO HIDDEN ADMIN-SCOPING ASSUMPTION. A read tool receives (args, ctx) and may
 *     read ctx.adminId; every read tool in this catalogue ignores it (only actions
 *     use it — grep `ctx.adminId` under tools/). If a future read tool becomes
 *     admin-scoped, this key MUST become scope-aware FIRST. Stated here so the
 *     assumption is auditable instead of implicit.
 *   - A REJECTION IS NEVER CACHED: only resolved values are stored, so one failed
 *     query cannot pin an error in front of admins for 15 seconds.
 *   - BOUNDED: max ~200 entries, oldest-inserted evicted first (Map order →
 *     FIFO/LRU-ish). An id-heavy question space cannot grow this without bound.
 *   - FAIL-OPEN AND SWITCHABLE: active only while the shared cache layer is
 *     enabled (config.redis.enabled). With Redis off — dev and every DB test —
 *     this is a passthrough, so test/dev behaviour is unchanged.
 *
 * The payload is shared by reference between callers. That is safe because
 * _kit.redactPayload() is non-destructive (see src/services/agent/pii.js:
 * "Non-destructive: returns a new structure") and nothing mutates a tool payload
 * in place.
 */

const config = require('../../config/env');
// _kit lives in tools/ — this module deliberately sits ABOVE it (in services/agent/)
// so the tool layer and the graph can both reach for the cache without tools/ and the
// graph importing each other.
const { KIND_READ, cacheKeyFor } = require('./tools/_kit');

/** Hard bounds — small enough to be invisible in RSS, large enough to matter. */
const MAX_ENTRIES = 200;
const MAX_TTL_SECONDS = 15;

/**
 * A tiny TTL map. `now` is injectable so expiry is testable without sleeping (a
 * test must not need wall-clock time to prove a TTL).
 */
function createTtlCache({ maxEntries = MAX_ENTRIES, now = Date.now } = {}) {
  // Insertion order IS eviction order: a read refreshes its own recency, so this
  // behaves as LRU for the workload that matters (a few hot questions).
  const store = new Map();
  let hits = 0;
  let misses = 0;

  function get(key) {
    const entry = store.get(key);
    if (!entry) {
      misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= now()) {
      store.delete(key);
      misses += 1;
      return undefined;
    }
    store.delete(key);
    store.set(key, entry);
    hits += 1;
    return entry.value;
  }

  function set(key, value, ttlSeconds) {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return;
    if (store.has(key)) store.delete(key);
    store.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
    while (store.size > maxEntries) {
      store.delete(store.keys().next().value);
    }
  }

  return {
    get,
    set,
    size: () => store.size,
    stats: () => ({ size: store.size, hits, misses }),
    clear: () => store.clear(),
  };
}

/**
 * Is the shared cache layer switched on at all?
 *
 * The micro-cache exists to cover the shared layer's fail-open path (Redis down →
 * every read falls through to Postgres), so when the shared layer is switched off
 * entirely — dev, and every DB test run — this stays a passthrough. Test and dev
 * behaviour is then exactly what it was before Phase 4.5, which is why the DB
 * suites can keep asserting real query counts.
 */
function isActive() {
  return Boolean(config.redis && config.redis.enabled);
}

/** Process-wide: shared by every turn, so one hot question hits the DB once. */
const localCache = createTtlCache();

/**
 * Wrap ONE read definition so its DB call can be served from the micro-cache.
 *
 * Only `def.run` is wrapped, and the result is a shallow copy of the definition, so
 * every other cross-cutting behaviour in _kit.execute() still runs on EVERY call:
 * strict argument validation, the row cap, the approval gate, the audit row, PII
 * redaction and result meta. The cache replaces the payload SOURCE only — the
 * cached value is re-finalized (and therefore re-redacted) each time it is served.
 *
 * Anything that is not a cacheable read is returned UNCHANGED, so no future caller
 * can accidentally arm the cache for an action (an action must always reach the DB).
 */
function wrapReadDefinition(def) {
  if (!def || def.kind !== KIND_READ) return def;
  if (typeof def.run !== 'function') return def;
  if (!Number.isSafeInteger(def.cacheTtlSeconds) || def.cacheTtlSeconds <= 0) return def;

  // Strictly shorter than the definition's own TTL: the local layer may only ever be
  // fresher-or-equal to what the shared cache would have served, never staler.
  const ttlSeconds = Math.min(def.cacheTtlSeconds, MAX_TTL_SECONDS);
  const runThroughDb = def.run;

  return {
    ...def,
    async run(args, ctx) {
      if (!isActive()) return runThroughDb(args, ctx);
      // The same key shape the shared cache uses, so both layers agree on what
      // "the same query" means for the same arguments.
      const key = cacheKeyFor(def.name, args);
      const hit = localCache.get(key);
      if (hit !== undefined) return hit;
      const value = await runThroughDb(args, ctx);
      // Only resolved values are stored: one failed query must not be pinned in front
      // of admins for the rest of the TTL.
      localCache.set(key, value, ttlSeconds);
      return value;
    },
  };
}

module.exports = {
  MAX_ENTRIES,
  MAX_TTL_SECONDS,
  createTtlCache,
  wrapReadDefinition,
  isActive,
  localCache,
  cacheStats: () => localCache.stats(),
  clearCache: () => localCache.clear(),
};

