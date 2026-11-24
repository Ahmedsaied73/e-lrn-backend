'use strict';

const redisClient = require('../../integrations/redis/redisClient');
const { AppError } = require('../../utils/AppError');
const defaultConfig = require('./config');

function createMemoryStore(nowFn = Date.now) {
  const map = new Map();
  const getEntry = (key) => {
    const entry = map.get(key);
    if (!entry) return null;
    if (entry.expiresAt && nowFn() > entry.expiresAt) {
      map.delete(key);
      return null;
    }
    return entry;
  };
  return {
    async get(key) {
      const e = getEntry(key);
      return e ? e.value : null;
    },
    async set(key, value, ttlSec) {
      map.set(key, {
        value: String(value),
        expiresAt: ttlSec ? nowFn() + ttlSec * 1000 : null,
      });
    },
    async incr(key, ttlSec) {
      const e = getEntry(key);
      const next = (e ? Number(e.value) || 0 : 0) + 1;
      const expiresAt = e ? e.expiresAt : ttlSec ? nowFn() + ttlSec * 1000 : null;
      map.set(key, { value: String(next), expiresAt });
      return next;
    },
    async incrByFloat(key, delta, ttlSec) {
      const e = getEntry(key);
      const next = (e ? Number(e.value) || 0 : 0) + Number(delta);
      const expiresAt = e ? e.expiresAt : ttlSec ? nowFn() + ttlSec * 1000 : null;
      map.set(key, { value: String(next), expiresAt });
      return next;
    },
  };
}

function createRedisStore(fallbackStore) {
  async function getReadyClient() {
    if (!redisClient.isRedisEnabled()) return null;
    const ready = await redisClient.ensureConnected(1500);
    return ready ? redisClient.getRedis() : null;
  }

  return {
    async get(key) {
      const client = await getReadyClient();
      if (!client) return fallbackStore.get(key);
      try {
        return await client.get(key);
      } catch {
        return fallbackStore.get(key);
      }
    },
    async set(key, value, ttlSec) {
      const client = await getReadyClient();
      if (!client) return fallbackStore.set(key, value, ttlSec);
      try {
        if (ttlSec) return await client.set(key, String(value), 'EX', ttlSec);
        return await client.set(key, String(value));
      } catch {
        return fallbackStore.set(key, value, ttlSec);
      }
    },
    async incr(key, ttlSec) {
      const client = await getReadyClient();
      if (!client) return fallbackStore.incr(key, ttlSec);
      try {
        const val = await client.incr(key);
        if (val === 1 && ttlSec) await client.expire(key, ttlSec);
        return val;
      } catch {
        return fallbackStore.incr(key, ttlSec);
      }
    },
    async incrByFloat(key, delta, ttlSec) {
      const client = await getReadyClient();
      if (!client) return fallbackStore.incrByFloat(key, delta, ttlSec);
      try {
        const val = Number(await client.incrbyfloat(key, delta));
        if (ttlSec) {
          const ttl = await client.ttl(key);
          if (ttl < 0) await client.expire(key, ttlSec);
        }
        return val;
      } catch {
        return fallbackStore.incrByFloat(key, delta, ttlSec);
      }
    },
  };
}

function createGuardrails(opts = {}) {
  const cfg = { ...defaultConfig, ...(opts.config || {}) };
  const nowFn = opts.nowFn || Date.now;
  const store = opts.store || createRedisStore(createMemoryStore(nowFn));
  let activeCount = 0;

  function dateKeys() {
    const d = new Date(nowFn());
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return {
      dailyKey: `essay_photo:budget:daily:${yyyy}-${mm}-${dd}`,
      monthlyKey: `essay_photo:budget:monthly:${yyyy}-${mm}`,
    };
  }

  async function checkBudgets() {
    const { dailyKey, monthlyKey } = dateKeys();
    const [dailyRaw, monthlyRaw] = await Promise.all([store.get(dailyKey), store.get(monthlyKey)]);
    const daily = Number(dailyRaw) || 0;
    const monthly = Number(monthlyRaw) || 0;
    if (daily >= cfg.dailyBudgetUsd || monthly >= cfg.monthlyBudgetUsd) {
      throw new AppError(
        'Essay photo extraction budget limit reached.',
        503,
        'ESSAY_PHOTO_BUDGET_EXCEEDED'
      );
    }
  }

  async function recordCost(costUsd) {
    if (!costUsd || costUsd <= 0) return;
    const { dailyKey, monthlyKey } = dateKeys();
    await Promise.all([
      store.incrByFloat(dailyKey, costUsd, 48 * 3600),
      store.incrByFloat(monthlyKey, costUsd, 35 * 24 * 3600),
    ]);
  }

  async function checkBurst(userId) {
    const key = `essay_photo:burst:${userId}`;
    const count = await store.incr(key, cfg.BURST_WINDOW_SEC || 30);
    if (count > (cfg.BURST_LIMIT || 3)) {
      throw new AppError(
        'Too many photo extraction requests. Please wait a moment.',
        429,
        'ESSAY_PHOTO_RATE_LIMITED'
      );
    }
  }

  async function getExamAttempts(attemptId) {
    const raw = await store.get(`essay_photo:attempts:${attemptId}`);
    return Number(raw) || 0;
  }

  async function checkExamAttempts(attemptId) {
    const current = await getExamAttempts(attemptId);
    if (current >= cfg.maxAttemptsPerExam) {
      throw new AppError(
        'Maximum photo extraction attempts reached for this exam.',
        429,
        'ESSAY_PHOTO_ATTEMPT_LIMIT'
      );
    }
    return current;
  }

  async function incrementExamAttempts(attemptId) {
    return store.incr(`essay_photo:attempts:${attemptId}`, 24 * 3600);
  }

  async function getDedup(dedupKey) {
    const raw = await store.get(`essay_photo:dedup:${dedupKey}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function setDedup(dedupKey, payload) {
    await store.set(
      `essay_photo:dedup:${dedupKey}`,
      JSON.stringify(payload),
      cfg.DEDUP_TTL_SEC || 600
    );
  }

  async function withConcurrencyLimit(fn) {
    if (activeCount >= cfg.maxConcurrency) {
      throw new AppError(
        'Essay photo service is busy. Please try again shortly.',
        503,
        'ESSAY_PHOTO_OVERLOADED'
      );
    }
    activeCount += 1;
    try {
      return await fn();
    } finally {
      activeCount -= 1;
    }
  }

  return {
    checkBudgets,
    recordCost,
    checkBurst,
    getExamAttempts,
    checkExamAttempts,
    incrementExamAttempts,
    getDedup,
    setDedup,
    withConcurrencyLimit,
    getActiveCount: () => activeCount,
  };
}

const defaultGuardrails = createGuardrails();

module.exports = {
  createGuardrails,
  createMemoryStore,
  defaultGuardrails,
};
