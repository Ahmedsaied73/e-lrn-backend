'use strict';
/* BE Redis cache contract suite for the P4–P5 hardening round (node:test).
 * Pins the four new/tightened Redis behaviors so they cannot silently
 * regress:
 *   R4  unread-count cache (v1:notif:unread:{userId}) — populated by
 *       GET /notifications/unread-count, invalidated when a notification is
 *       created for the user;
 *   R5  /user/me payload cache (v1:me:{userId}) — populated by GET /user/me,
 *       invalidated by PUT /user/:slug;
 *   R7  lockout state read is a single atomic Lua round-trip (recordFailure /
 *       getLockState / clearFailures stay consistent);
 *   BullMQ retention lives in Queue defaultJobOptions (count+age), not in
 *   per-add options.
 *
 * Requires the same Redis the app uses (REDIS_URL in .env). Net-zero: the
 * scratch student, their notifications, and all v1: keys are removed in
 * after().
 *
 * Run: npm test
 */
process.chdir(__dirname + '/..');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createToken } = require('../src/utils.js');
const config = require('../src/config/env.js');
const { randomBase36Slug } = require('../src/utils/slugs.js');
const { PrismaClient } = require('@prisma/client');
const { getRedis, ensureConnected, disconnectRedis } = require('../src/integrations/redis/redisClient.js');
const cache = require('../src/integrations/redis/cache.js');

const API = process.env.TEST_BASE_URL || 'http://localhost:3005';
const prisma = new PrismaClient();

const adminCookie = () =>
  `accessToken=${createToken({ id: 1, email: 'admin@elearning.com', name: 'T', role: 'ADMIN' }, config.jwt.secret)}`;

async function req(method, path, cookie, body) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

let student = null;
let redisUp = false;

function skipUnlessRedis(t) {
  if (!redisUp) {
    t.skip('Redis unreachable');
    return true;
  }
  return false;
}

describe('P4–P5 Redis caches', () => {
  before(async () => {
    // Fail fast when Redis is down (fail-open by design in the app): these
    // tests pin cache behavior and are meaningless without a live store.
    // Race ensureConnected against a hard timeout so a dead Redis (e.g. a
    // suspended dev instance) skips the suite instead of stalling it.
    const client = getRedis();
    if (client) {
      try {
        await Promise.race([
          ensureConnected().then(() => client.ping()),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
        ]);
        redisUp = client.status === 'ready';
      } catch {
        redisUp = false;
      }
    }
    if (!redisUp) {
      console.warn('[p45-cache-tests] Redis unreachable — cache assertions skipped (app is fail-open by design).');
      return;
    }
    const email = `p45cache-${Date.now()}@localhost.test`;
    const user = await prisma.user.create({
      data: { slug: randomBase36Slug(), name: 'P45', email, password: 'x', grade: 'FIRST_SECONDARY' },
    });
    student = {
      user,
      cookie: `accessToken=${createToken({ id: user.id, email, name: 'P45', role: 'STUDENT' }, config.jwt.secret)}`,
    };
  });

  after(async () => {
    if (student) {
      await prisma.notification.deleteMany({ where: { userId: student.user.id } });
      await prisma.user.delete({ where: { id: student.user.id } });
      assert.equal(await prisma.user.count({ where: { id: student.user.id } }), 0, 'net-zero user');
      await cache.del(
        cache.buildKey('me', String(student.user.id)),
        cache.buildKey('me', '1'),
        cache.buildKey('notif', 'unread', String(student.user.id))
      );
    }
    await prisma.$disconnect();
    // Drop the shared client so a dead Redis's reconnect loop can't pin the
    // test subprocess open after the suite finishes.
    await disconnectRedis().catch(() => {});
  });


  it('R5: GET /user/me populates v1:me:{id}; PUT /user/:slug invalidates it', async (t) => {
    if (skipUnlessRedis(t)) return;
    const meKey = cache.buildKey('me', String(student.user.id));
    await cache.del(meKey);

    const first = await req('GET', '/user/me', student.cookie);
    assert.equal(first.status, 200, 'me reachable');
    const client = getRedis();
    assert.ok(await client.get(meKey), 'me payload is cached after first read');

    const upd = await req('PUT', `/user/${student.user.slug}`, student.cookie, { name: 'P45 Renamed' });
    assert.equal(upd.status, 200, 'self name update');
    assert.equal(await client.get(meKey), null, 'update invalidates the me cache');

    const second = await req('GET', '/user/me', student.cookie);
    assert.equal(second.json.data.name, 'P45 Renamed', 'next read sees the write');
  });

  it('R4: unread-count is cached and invalidated when a notification is created', async (t) => {
    if (skipUnlessRedis(t)) return;
    const key = cache.buildKey('notif', 'unread', String(student.user.id));
    await cache.del(key);

    const r = await req('GET', '/notifications/unread-count', student.cookie);
    assert.equal(r.status, 200, 'unread-count reachable');
    const client = getRedis();
    assert.ok(await client.get(key), 'count is cached after first poll');

    // Create a notification through the SERVICE (the only writer) — its
    // invalidation must drop the cached badge count immediately.
    const notificationService = require('../src/services/notifications/notificationService.js');
    await notificationService.createForUsers({
      userIds: [student.user.id],
      type: 'ADMIN_BROADCAST',
      title: 'p45 cache test',
    });
    assert.equal(await client.get(key), null, 'createForUsers invalidates the cached count');

    const r2 = await req('GET', '/notifications/unread-count', student.cookie);
    assert.equal(r2.json.data.count, 1, 'recomputed count reflects the new notification');
  });

  it('R7: lockout record/read/clear stay consistent (atomic Lua read)', async (t) => {
    if (skipUnlessRedis(t)) return;
    const { getLockState, recordFailure, clearFailures } = require('../src/integrations/redis/accountLockout.js');
    const email = `p45-lock-${Date.now()}@localhost.test`;
    try {
      await clearFailures(email);
      let state = await getLockState(email);
      assert.equal(state.locked, false);
      assert.equal(state.failures, 0);

      const rec = await recordFailure(email);
      assert.equal(rec.failures, 1, 'INCR counted the failure');
      state = await getLockState(email);
      assert.equal(state.failures, 1, 'atomic read sees the same counter');
      assert.equal(state.locked, false, 'one failure is below threshold');

      await clearFailures(email);
      state = await getLockState(email);
      assert.equal(state.failures, 0, 'clear resets the counter');
    } finally {
      await clearFailures(email);
    }
  });

  it('BullMQ retention: Queue defaultJobOptions carry count+age', async (t) => {
    if (skipUnlessRedis(t)) return;
    if (!(config.features && config.features.aiGrader !== false)) return; // module off — nothing to pin
    const { getGradingQueue, closeGradingQueue } = require('../src/services/aiGrader/queue.js');
    try {
      const q = getGradingQueue();
      const djo = q.opts && q.opts.defaultJobOptions;
      assert.ok(djo, 'defaultJobOptions set on the queue');
      assert.equal(djo.attempts, 3);
      assert.deepEqual(djo.removeOnComplete, { count: 200, age: 86400 }, 'completed jobs: bounded + aged out');
      assert.deepEqual(djo.removeOnFail, { count: 1000, age: 604800 }, 'failed jobs: bounded + aged out');
    } finally {
      await closeGradingQueue();
    }
  });
});
