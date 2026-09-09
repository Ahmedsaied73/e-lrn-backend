'use strict';

/**
 * verify-cache.js — acceptance matrix for the Redis cache layer.
 * Run: node scripts/verify-cache.js
 * Exit 0 = all green. Uses key prefix `test:` (never touches app keys) and
 * cleans up after itself. The Redis-down case runs in a child process pointed
 * at a dead port so the parent's healthy client is untouched.
 */
process.chdir(__dirname + '/..');
const { spawnSync } = require('child_process');
const cache = require('../src/integrations/redis/cache');
const { getRedis, disconnectRedis } = require('../src/integrations/redis/redisClient');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
    console.log('PASS', name);
  } catch (e) {
    results.push(['FAIL', `${name} — ${e.message}`]);
    console.log('FAIL', name, '—', e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const P = 'test:verify:';

  // Warm up: first connect takes ~2s (TLS handshake). Real traffic fails open
  // during this window by design; the test needs a ready client to assert hits.
  const { ensureConnected } = require('../src/integrations/redis/redisClient');
  assert(await ensureConnected(20000) === true, 'could not reach Upstash — aborting');
  console.log('warmup: connected');

  await check('set/get round trip', async () => {
    assert(await cache.set(`${P}obj`, { a: 1, b: 'x' }, 60) === true, 'set true');
    const v = await cache.get(`${P}obj`);
    assert(v && v.a === 1 && v.b === 'x', 'got object back');
  });

  await check('miss returns null', async () => {
    assert((await cache.get(`${P}nope-not-here`)) === null, 'null on miss');
  });

  await check('TTL expiry', async () => {
    await cache.set(`${P}ttl`, { t: 1 }, 1);
    assert((await cache.get(`${P}ttl`)) !== null, 'present before expiry');
    await sleep(1500);
    assert((await cache.get(`${P}ttl`)) === null, 'gone after expiry');
  });

  await check('del removes keys', async () => {
    await cache.set(`${P}del1`, { x: 1 }, 60);
    await cache.set(`${P}del2`, { x: 2 }, 60);
    assert((await cache.del(`${P}del1`, `${P}del2`)) === 2, 'del count 2');
    assert((await cache.get(`${P}del1`)) === null, 'del1 gone');
  });

  await check('delPrefix removes namespace only', async () => {
    await cache.set(`${P}ns:a`, { x: 1 }, 60);
    await cache.set(`${P}ns:b`, { x: 2 }, 60);
    await cache.set(`${P}other`, { x: 3 }, 60);
    const n = await cache.delPrefix(`${P}ns:`);
    assert(n === 2, `removed 2, got ${n}`);
    assert((await cache.get(`${P}other`)) !== null, 'outside prefix kept');
    await cache.del(`${P}other`);
  });

  await check('malformed value is a miss + cleaned', async () => {
    await getRedis().set(`${P}bad`, 'not-json{{{', 'EX', 60);
    assert((await cache.get(`${P}bad`)) === null, 'malformed -> null');
    assert((await getRedis().get(`${P}bad`)) === null, 'malformed entry deleted');
  });

  await check('oversize value rejected', async () => {
    const big = { s: 'x'.repeat(300 * 1024) };
    assert((await cache.set(`${P}big`, big, 60)) === false, 'set false');
    assert((await cache.get(`${P}big`)) === null, 'not stored');
  });

  await check('withCache: loader runs on miss, skipped on hit', async () => {
    let calls = 0;
    const loader = async () => { calls += 1; return { n: 7 }; };
    const a = await cache.withCache(`${P}wc`, 60, loader);
    const b = await cache.withCache(`${P}wc`, 60, loader);
    assert(a.n === 7 && b.n === 7, 'values match');
    assert(calls === 1, `loader called once, got ${calls}`);
    await cache.del(`${P}wc`);
  });

  await check('null/undefined never cached', async () => {
    let calls = 0;
    await cache.withCache(`${P}nil`, 60, async () => { calls += 1; return null; });
    await cache.withCache(`${P}nil`, 60, async () => { calls += 1; return null; });
    assert(calls === 2, `null recomputed, calls=${calls}`);
  });

  await check('user isolation (distinct keys)', async () => {
    await cache.set(`${P}u:1`, { who: 'one' }, 60);
    await cache.set(`${P}u:2`, { who: 'two' }, 60);
    assert((await cache.get(`${P}u:1`)).who === 'one', 'u1 isolated');
    assert((await cache.get(`${P}u:2`)).who === 'two', 'u2 isolated');
    await cache.del(`${P}u:1`, `${P}u:2`);
  });

  await check('Redis-down fallback (child on dead port)', async () => {
    const child = spawnSync(
      process.execPath,
      ['-e', `
        process.chdir('H:/e-learning-platform');
        const cache = require('H:/e-learning-platform/src/integrations/redis/cache.js');
        const { disconnectRedis } = require('H:/e-learning-platform/src/integrations/redis/redisClient.js');
        (async () => {
          const v = await cache.withCache('test:down:k', 60, async () => ({ from: 'db' }));
          if (!v || v.from !== 'db') throw new Error('loader fallback broken');
          if ((await cache.get('test:down:k')) !== null) throw new Error('unreachable redis returned data');
          console.log('child-fallback-ok');
          await disconnectRedis();
          process.exit(0);
        })().catch(async (e) => { console.error('child FAIL:', e.message); try { await disconnectRedis(); } catch {} process.exit(1); });
      `],
      {
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, REDIS_URL: 'redis://127.0.0.1:9', REDIS_ENABLED: 'true' },
      },
    );
    const out = `${child.stdout || ''}${child.stderr || ''}`;
    assert(child.status === 0 && out.includes('child-fallback-ok'), `child green, got: ${out.slice(-300)}`);
  });

  await check('stats counters move', async () => {
    const s = cache.stats();
    assert(s.hits >= 2 && s.misses >= 2 && s.sets >= 2, `counters sane: ${JSON.stringify(s)}`);
  });

  // final sweep of our test namespace
  await cache.delPrefix(P);
  await disconnectRedis();

  const fails = results.filter((r) => r[0] === 'FAIL');
  if (fails.length) {
    console.log(`\nVERIFY-CACHE FAILED (${fails.length}):\n` + fails.map((f) => f[1]).join('\n'));
    process.exit(1);
  }
  console.log('\nVERIFY-CACHE GREEN');
})().catch(async (e) => {
  console.error('VERIFY-CACHE ERROR:', e.message);
  try { await disconnectRedis(); } catch { /* ignore */ }
  process.exit(1);
});
