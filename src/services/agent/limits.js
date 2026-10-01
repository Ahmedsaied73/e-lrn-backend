'use strict';

/**
 * limits.js — the per-admin turn budget shared by BOTH agent surfaces (Phase 4.5).
 *
 * WHY THIS EXISTS: the per-minute ask limiter was mounted on the REST route only.
 * The WebSocket surface — the CHEAPER path to abuse, since one authenticated socket
 * can fire turns in a tight loop with no HTTP overhead — had no limiter at all, and
 * `config.aiAgent.dailyTurnBudget` (default 500) was asserted by a test but enforced
 * NOWHERE. An admin account was therefore an unlimited, unbudgeted LLM bill.
 *
 * ONE policy, two surfaces. This module is the only place that decides whether a
 * turn may run, so REST and the socket cannot drift apart — a rate limit that
 * exists on one transport and not the other is not a rate limit.
 *
 * TWO BUCKETS, because they answer different questions:
 *   minute  a stuck client or a retry loop is throttled immediately.
 *   day     the ceiling that bounds spend, and the number an operator can quote.
 *
 * FAIL-OPEN, ALWAYS. When Redis is unreachable this falls back to a bounded
 * in-process counter, exactly like rateLimitStore.js's local fallback. A provider
 * outage or a Redis flap must never turn into "the admin cannot ask a question":
 * this process is logging read ECONNRESET as it stands, and a 503 here would be a
 * self-inflicted outage. The honest cost of failing open is that the ceiling becomes
 * per-process during an outage — documented here rather than hidden.
 *
 * Everything is injectable (redis, clock, caps) so the policy is testable with no
 * network and no sleeping — a test must not need wall-clock time to prove a budget.
 */

const config = require('../../config/env');
const { getRedis, isRedisReady } = require('../../integrations/redis/redisClient');

/** Default per-minute cap: the same number the REST limiter shipped with. */
const DEFAULT_PER_MINUTE_MAX = Number(process.env.AI_AGENT_ASK_LIMIT) || 60;

/** In-process fallback cap, mirroring rateLimitStore.js's local map. */
const LOCAL_MAP_MAX = 5000;

/** How long a minute bucket lives: long enough to be useless after its minute. */
const MINUTE_BUCKET_TTL_MS = 2 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');

/** 20260926 — sortable, and readable in a Redis key list at 3am. */
function dayStamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** 2026092614 — the minute bucket, so counters expire on their own. */
function minuteStamp(date) {
  return `${dayStamp(date)}${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** Seconds until the next local midnight, so a day bucket cannot outlive its day. */
function secondsUntilMidnight(date) {
  const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return Math.max(60, Math.ceil((midnight.getTime() - date.getTime()) / 1000));
}

/**
 * A counter that works with or without Redis. The Redis path is two commands
 * (INCR, then EXPIRE only on the first hit); the local path is a Map with a lazy
 * sweep. Both return the NEW count, which is what the cap is compared against.
 */
function createCounter({ redis, ttlSeconds }) {
  const local = new Map();

  function sweep() {
    const now = Date.now();
    for (const [key, entry] of local) if (entry.expiresAt <= now) local.delete(key);
    // A hard cap: an id-heavy key space must not grow this without bound.
    while (local.size > LOCAL_MAP_MAX) local.delete(local.keys().next().value);
  }

  async function incrementLocal(key) {
    sweep();
    const now = Date.now();
    const existing = local.get(key);
    const count = (existing && existing.expiresAt > now ? existing.count : 0) + 1;
    local.set(key, { count, expiresAt: now + ttlSeconds * 1000 });
    return count;
  }

  return {
    get size() {
      return local.size;
    },
    async increment(key) {
      if (redis) {
        try {
          const value = await redis.incr(key);
          if (Number(value) === 1) await redis.expire(key, ttlSeconds);
          return Number(value);
        } catch {
          // Fall through: a limiter must never be the reason a request fails.
        }
      }
      return incrementLocal(key);
    },
    clear() {
      local.clear();
    },
  };
}


/**
 * @param {object} [options]
 * @param {object} [options.redis]        a redis-like client (incr/expire). Default: the shared one.
 * @param {() => Date} [options.now]      clock seam, so TTLs are testable without sleeping.
 * @param {number} [options.perMinuteMax]
 * @param {number} [options.dailyBudget]  default: config.aiAgent.dailyTurnBudget (already clamped).
 */
function createTurnLimits({ redis, now = () => new Date(), perMinuteMax, dailyBudget } = {}) {
  const minuteMax = Number.isSafeInteger(perMinuteMax) && perMinuteMax > 0 ? perMinuteMax : DEFAULT_PER_MINUTE_MAX;
  const dayMax = Number.isSafeInteger(dailyBudget) && dailyBudget > 0 ? dailyBudget : config.aiAgent.dailyTurnBudget;

  function client() {
    if (redis !== undefined) return redis;
    try {
      return isRedisReady() ? getRedis() : null;
    } catch {
      return null;
    }
  }

  // One counter per bucket key, so a turn costs one INCR per bucket rather than
  // rebuilding a client mid-request.
  const counters = new Map();

  async function bump(key, ttlSeconds) {
    const id = `${key}|${ttlSeconds}`;
    let counter = counters.get(id);
    if (!counter) {
      counter = createCounter({ redis: client(), ttlSeconds });
      counters.set(id, counter);
    }
    return counter.increment(key);
  }

  /**
   * Count one turn attempt and say whether it may proceed.
   *
   * The turn is counted in BOTH buckets even when it is refused: a client that
   * keeps hammering a closed budget must not be able to retry its way past it.
   *
   * @returns {Promise<{ allowed: boolean, code: null|'RATE_LIMITED'|'DAILY_BUDGET_EXCEEDED', retryAfterMs: number|null, minuteCount: number, dayCount: number }>}
   */
  async function checkAndCount(adminId) {
    if (!Number.isSafeInteger(adminId) || adminId <= 0) {
      // An unidentifiable caller is refused rather than counted against nobody.
      return { allowed: false, code: 'RATE_LIMITED', retryAfterMs: MINUTE_BUCKET_TTL_MS, minuteCount: 0, dayCount: 0 };
    }

    const at = now();
    const minute = await bump(`agent:turns:m:${adminId}:${minuteStamp(at)}`, MINUTE_BUCKET_TTL_MS / 1000);
    const day = await bump(`agent:turns:d:${adminId}:${dayStamp(at)}`, secondsUntilMidnight(at));

    if (minute > minuteMax) {
      return {
        allowed: false,
        code: 'RATE_LIMITED',
        retryAfterMs: MINUTE_BUCKET_TTL_MS,
        minuteCount: minute,
        dayCount: day,
      };
    }
    if (day > dayMax) {
      return {
        allowed: false,
        code: 'DAILY_BUDGET_EXCEEDED',
        // Until local midnight: an admin told "try again in a moment" about a DAILY
        // ceiling would hammer the endpoint for the rest of the evening.
        retryAfterMs: secondsUntilMidnight(at) * 1000,
        minuteCount: minute,
        dayCount: day,
      };
    }
    return { allowed: true, code: null, retryAfterMs: null, minuteCount: minute, dayCount: day };
  }

  return {
    checkAndCount,
    limits: { perMinuteMax: minuteMax, dailyBudget: dayMax },
    /** Test seam: process-local counters must be clearable between assertions. */
    reset() {
      for (const counter of counters.values()) counter.clear();
    },
  };
}

/**
 * The process-wide instance both surfaces use. Created lazily so that requiring
 * this module (or the routes, in every test) never opens a Redis handle.
 */
let shared = null;
function turnLimits() {
  if (!shared) shared = createTurnLimits();
  return shared;
}

/** Test seam for the shared instance. */
function resetTurnLimits() {
  if (shared) shared.reset();
  shared = null;
}

module.exports = {
  createTurnLimits,
  turnLimits,
  resetTurnLimits,
  DEFAULT_PER_MINUTE_MAX,
  MINUTE_BUCKET_TTL_MS,
  dayStamp,
  minuteStamp,
  secondsUntilMidnight,
};
