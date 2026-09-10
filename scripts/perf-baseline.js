'use strict';

/**
 * perf-baseline.js — latency profiler for hot read paths.
 * Run: node scripts/perf-baseline.js
 *
 * Measures N samples per endpoint (first sample discarded as warmup/connect)
 * and reports min/median/p95/max. Cold-vs-warm for cached endpoints is done
 * with distinct cache keys (unique pages) vs a repeated URL — no flush hacks.
 * Read-only: creates no data (uses existing demo course + seqaccess student).
 */
process.chdir(__dirname + '/..');
const { createToken } = require('../src/utils.js');
const config = require('../src/config/env.js');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const API = process.env.PERF_BASE_URL || 'http://localhost:3005';
const N = 15;

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

async function measure(label, url, cookie, keyFn) {
  const samples = [];
  let status = null;
  for (let i = 0; i < N + 1; i++) {
    const u = typeof keyFn === 'function' ? keyFn(i, url) : url;
    const t0 = Date.now();
    try {
      const res = await fetch(u, { headers: { Cookie: cookie } });
      await res.arrayBuffer().catch(() => {});
      status = res.status;
      if (i > 0) samples.push(Date.now() - t0);
    } catch (e) {
      if (i > 0) samples.push(-1);
    }
  }
  samples.sort((a, b) => a - b);
  const good = samples.filter((s) => s >= 0);
  console.log(
    `${label}\n  status=${status} n=${good.length} min=${quantile(good, 0)}ms ` +
    `med=${quantile(good, 0.5)}ms p95=${quantile(good, 0.95)}ms max=${quantile(good, 1)}ms`
  );
  return { status, samples: good };
}

(async () => {
  const forge = (id, email, role) =>
    `accessToken=${createToken({ id, email, name: 'P', role }, config.jwt.secret)}`;
  const adminCookie = forge(1, 'admin@elearning.com', 'ADMIN');
  const seq = await prisma.user.findUnique({
    where: { email: 'seqaccess@localhost.test' },
    select: { id: true },
  });
  const seqCookie = forge(seq.id, 'seqaccess@localhost.test', 'STUDENT');

  console.log(`--- baseline against ${API} (${N} samples, first discarded) ---`);
  await measure('user/me (cheap baseline)', `${API}/user/me`, adminCookie);
  await measure('courses list COLD (distinct pages)', `${API}/courses/`, adminCookie, (i, u) => `${u}?limit=20&page=${101 + i}`);
  await measure('courses list WARM (same URL)', `${API}/courses/?limit=20&page=1`, adminCookie);
  await measure('course videos list (admin, cached 60s)', `${API}/courses/1/bunny-videos`, adminCookie);
  await measure('trending WARM', `${API}/search/trending?limit=5`, adminCookie);
  await measure('search content (heavy + distinct scan)', `${API}/search/content?query=${encodeURIComponent('test')}&limit=5`, adminCookie);
  await measure('quiz meta (student, up to 4q)', `${API}/quizzes/videos/1/meta`, seqCookie);
  await measure('playback gate path (student, up to 9q)', `${API}/videos/2/playback`, seqCookie);
  await measure('admin dashboard (16q)', `${API}/admin/dashboard`, adminCookie);
  await measure('progress course (student)', `${API}/progress/course/1`, seqCookie);

  await prisma.$disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error('BASELINE ERROR:', e.message);
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
