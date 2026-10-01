'use strict';
/* Agent turn budget (Phase 4.5) — pure: no DB, no network, no wall-clock waiting.
 *
 * The socket path had NO limiter at all and `dailyTurnBudget` was enforced nowhere,
 * so these tests exist to make that unrepeatable. Everything is driven through the
 * injected redis stub and clock, so "the budget is enforced" is provable in
 * milliseconds instead of by waiting for midnight.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createTurnLimits,
  dayStamp,
  minuteStamp,
  secondsUntilMidnight,
  MINUTE_BUCKET_TTL_MS,
} = require('../src/services/agent/limits');

/** A redis stub: counts, and records the keys so the tests can assert on them. */
function redisStub({ failOn = null } = {}) {
  const store = new Map();
  const calls = { incr: [], expire: [] };
  return {
    store,
    calls,
    async incr(key) {
      calls.incr.push(key);
      if (failOn === 'incr') throw new Error('ECONNRESET');
      const next = (store.get(key) || 0) + 1;
      store.set(key, next);
      return String(next);
    },
    async expire(key, ttl) {
      calls.expire.push({ key, ttl });
      if (failOn === 'expire') throw new Error('ECONNRESET');
      return 1;
    },
  };
}

/** A clock a test can move, so no assertion has to sleep. */
function clock(startIso = '2026-09-26T10:00:00') {
  const state = { at: new Date(startIso) };
  return {
    now: () => new Date(state.at),
    advanceMs(ms) {
      state.at = new Date(state.at.getTime() + ms);
    },
    set(iso) {
      state.at = new Date(iso);
    },
  };
}

describe('agent turn budget — the policy', () => {
  it('allows turns under the per-minute cap and refuses the one past it', async () => {
    const limits = createTurnLimits({ redis: redisStub(), now: clock().now, perMinuteMax: 3, dailyBudget: 100 });

    for (let i = 1; i <= 3; i += 1) {
      const verdict = await limits.checkAndCount(1);
      assert.equal(verdict.allowed, true, `turn ${i} should be allowed`);
      assert.equal(verdict.minuteCount, i);
    }

    const refused = await limits.checkAndCount(1);
    assert.equal(refused.allowed, false);
    assert.equal(refused.code, 'RATE_LIMITED');
    assert.ok(refused.retryAfterMs > 0, 'a refusal must say when to come back');
  });

  it('enforces the daily budget and distinguishes it from the per-minute limit', async () => {
    const limits = createTurnLimits({ redis: redisStub(), now: clock().now, perMinuteMax: 100, dailyBudget: 5 });

    for (let i = 0; i < 5; i += 1) assert.equal((await limits.checkAndCount(2)).allowed, true);

    const refused = await limits.checkAndCount(2);
    assert.equal(refused.allowed, false);
    assert.equal(refused.code, 'DAILY_BUDGET_EXCEEDED', 'a daily ceiling must not masquerade as a rate limit');
    // Until midnight, not "in a minute" — otherwise a client retries all evening.
    assert.ok(refused.retryAfterMs >= 3600_000, 'the daily refusal must point at the next day');
  });

  it('counts a refused turn too, so retrying cannot walk past a closed budget', async () => {
    const limits = createTurnLimits({ redis: redisStub(), now: clock().now, perMinuteMax: 1, dailyBudget: 100 });
    assert.equal((await limits.checkAndCount(3)).allowed, true);
    for (let i = 0; i < 5; i += 1) {
      const verdict = await limits.checkAndCount(3);
      assert.equal(verdict.allowed, false, 'a closed budget stays closed under retries');
    }
  });

  it('keys by ADMIN, so two admins never share a bucket', async () => {
    const redis = redisStub();
    const limits = createTurnLimits({ redis, now: clock().now, perMinuteMax: 1, dailyBudget: 100 });
    assert.equal((await limits.checkAndCount(1)).allowed, true);
    // A different admin is unaffected by admin 1 exhausting their own bucket.
    assert.equal((await limits.checkAndCount(2)).allowed, true);
    const refused = await limits.checkAndCount(1);
    assert.equal(refused.allowed, false);
    assert.ok(redis.calls.incr.some((k) => k.includes(':1:')), 'keys must carry the admin id');
    assert.ok(redis.calls.incr.some((k) => k.includes(':2:')));
  });


  it('a new minute is a new bucket', async () => {
    const c = clock();
    // The daily budget is deliberately generous here: this test is about the MINUTE
    // bucket, and with dailyBudget: 1 the second turn would be refused for the daily
    // reason instead — which is a different test, below.
    const limits = createTurnLimits({ redis: redisStub(), now: c.now, perMinuteMax: 1, dailyBudget: 10 });

    assert.equal((await limits.checkAndCount(1)).allowed, true);
    assert.equal((await limits.checkAndCount(1)).allowed, false, 'the minute bucket is spent');

    c.advanceMs(60_000);
    assert.equal((await limits.checkAndCount(1)).allowed, true, 'the next minute is a fresh bucket');
  });

  it('a new day is a new budget, even when the minute bucket is free', async () => {
    const c = clock();
    const limits = createTurnLimits({ redis: redisStub(), now: c.now, perMinuteMax: 10, dailyBudget: 1 });

    assert.equal((await limits.checkAndCount(1)).allowed, true);
    const refused = await limits.checkAndCount(1);
    assert.equal(refused.code, 'DAILY_BUDGET_EXCEEDED');
    // A minute passing must NOT reopen a daily ceiling.
    c.advanceMs(60_000);
    assert.equal((await limits.checkAndCount(1)).allowed, false, 'a minute is not a day');

    c.set('2026-09-27T00:00:01');
    assert.equal((await limits.checkAndCount(1)).allowed, true, 'the next day is a fresh budget');
  });

  it('sets a TTL exactly once per bucket, and never outlives the day', async () => {
    const redis = redisStub();
    const limits = createTurnLimits({ redis, now: clock('2026-09-26T23:59:30').now, perMinuteMax: 5, dailyBudget: 5 });
    await limits.checkAndCount(1);
    await limits.checkAndCount(1);
    await limits.checkAndCount(1);

    const dayExpiries = redis.calls.expire.filter((c) => c.key.includes(':d:'));
    assert.equal(dayExpiries.length, 1, 'EXPIRE must be set once per key, not on every INCR');
    assert.ok(dayExpiries[0].ttl <= 60, 'a day bucket at 23:59 must expire within a minute');
  });

  it('FAIL-OPENS when Redis is down: a limiter must not become an outage', async () => {
    const limits = createTurnLimits({
      redis: redisStub({ failOn: 'incr' }),
      now: clock().now,
      perMinuteMax: 2,
      dailyBudget: 100,
    });
    // Redis throws on every call; the local counter must still bound the turn.
    assert.equal((await limits.checkAndCount(9)).allowed, true);
    assert.equal((await limits.checkAndCount(9)).allowed, true);
    const refused = await limits.checkAndCount(9);
    assert.equal(refused.allowed, false, 'the local fallback must still enforce the cap');
    assert.equal(refused.code, 'RATE_LIMITED');
  });

  it('refuses an unidentifiable caller instead of counting it against nobody', async () => {
    const limits = createTurnLimits({ redis: redisStub(), now: clock().now, perMinuteMax: 10, dailyBudget: 10 });
    for (const bad of [null, undefined, 0, -1, 1.5, '1']) {
      const verdict = await limits.checkAndCount(bad);
      assert.equal(verdict.allowed, false, `adminId ${String(bad)} must not be allowed`);
    }
  });

  it('reset() clears the process-local counters', async () => {
    const limits = createTurnLimits({ redis: null, now: clock().now, perMinuteMax: 1, dailyBudget: 10 });
    assert.equal((await limits.checkAndCount(4)).allowed, true);
    assert.equal((await limits.checkAndCount(4)).allowed, false);
    limits.reset();
    assert.equal((await limits.checkAndCount(4)).allowed, true, 'after a reset the budget is open again');
  });

  it('bucket keys are readable and sortable', () => {
    const at = new Date('2026-09-26T14:07:00');
    assert.equal(dayStamp(at), '20260926');
    assert.equal(minuteStamp(at), '202609261407');
    assert.ok(secondsUntilMidnight(new Date('2026-09-26T23:59:00')) <= 60);
    assert.ok(secondsUntilMidnight(new Date('2026-09-26T00:00:00')) > 3600);
    assert.equal(MINUTE_BUCKET_TTL_MS, 120_000);
  });
});
