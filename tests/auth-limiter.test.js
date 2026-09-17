'use strict';
/* Auth-limiter separation (M2/M4). Exhausting the login bucket must not 429
 * the refresh bucket (and vice versa — proven live in V1). No fixtures.
 *
 * Uses 127.0.0.1 explicitly: `localhost` flips between ::1/127.0.0.1 per
 * connection (Happy Eyeballs) and limiters key by IP, which would split the
 * 22 probes across two buckets and never trip either.
 */
process.chdir(__dirname + '/..');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getRedis } = require('../src/integrations/redis/redisClient');

const API = process.env.TEST_BASE_URL || 'http://127.0.0.1:3005';
const post = async (path, body) => {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  await res.text().catch(() => {});
  return res.status;
};

describe('auth limiter buckets', () => {
  it('login bucket trips without touching the refresh bucket', async () => {
    // Fail-open counting (slow Redis commands time out instead of counting)
    // makes the exact trip index load-dependent, so loop until the first 429
    // instead of asserting an exact position. Cap bounds the runtime.
    //
    // Since the security round (Layer 4) the login handler also enforces an
    // account lockout: 5 consecutive bad logins → 423 ACCOUNT_LOCKED with
    // Retry-After (Redis-backed, fail-open when Redis is off). The limiter
    // (20 req/15min/IP) has a larger budget than the per-account threshold, so
    // the loop legitimately observes 401 → 423 → 429. The point under test is
    // that the login bucket 429s and the refresh bucket stays untouched.
    const codes = [];
    let first429 = -1;
    for (let i = 0; i < 45 && first429 === -1; i++) {
      const s = await post('/auth/login', { email: 'nobody@localhost.test', password: 'wrongwrong' });
      codes.push(s);
      if (s === 429) first429 = i;
    }
    assert.ok(first429 !== -1 && first429 < 45, `login trips (first 429 at index ${first429})`);
    assert.ok(
      codes.slice(0, first429).every((c) => c === 401 || c === 423),
      'pre-trip logins are 401 (bad creds) or 423 (account lockout) — not rate-limited'
    );
    // Refresh bucket must be unaffected by the exhausted login bucket.
    const refresh = await post('/auth/refresh-token');
    assert.notEqual(refresh, 429, 'refresh unaffected by hot login bucket');
    try {
      const { getRedis } = require('../src/integrations/redis/redisClient');
      const client = getRedis();
      if (client) client.disconnect();
    } catch { /* ignore */ }
  });
});
