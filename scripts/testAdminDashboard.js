'use strict';

/**
 * Admin dashboard endpoint test (T0.1)
 *
 * Runs against live backend http://localhost:3005.
 * Coverage:
 *   A1  GET /admin/dashboard without auth        → 401
 *   A2  GET /admin/dashboard as STUDENT          → 403
 *   A3  GET /admin/dashboard as ADMIN            → 200, envelope, numeric counts
 *   A4  payload deep-scan                         → no password/refreshToken/answerKey leak
 */

const config = require('../src/config/env');

const BASE_URL = 'http://localhost:3005';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractCookies(response) {
  const raw = (typeof response.headers.getSetCookie === 'function' && response.headers.getSetCookie()) || [];
  const single = response.headers.get('set-cookie');
  const all = raw.length ? raw : single ? [single] : [];
  const names = new Set(['accessToken', 'refreshToken']);
  return all
    .map((c) => c.split(';')[0])
    .filter((pair) => names.has(pair.split('=')[0].trim()))
    .join('; ');
}

async function waitForServer() {
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.status === 200 || res.status === 404) {
        console.log('✓ Server is ready and responding.');
        return;
      }
    } catch (e) {
      // still booting
    }
    await sleep(1500);
  }
  throw new Error('Server did not respond in time. Start it with: npm run dev');
}

async function api(pathname, { cookie, method = 'GET', body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch (e) {
    parsed = null;
  }
  return { status: res.status, data: parsed };
}

async function loginAs(email, password) {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data, cookie: extractCookies(res) };
}

function deepScanForLeaks(node, path, found) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => deepScanForLeaks(item, `${path}[${i}]`, found));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const lower = key.toLowerCase();
      if (['password', 'refreshkey', 'refreshtoken', 'answerkey', 'secret'].some((s) => lower.includes(s))) {
        found.push(`${path}.${key}`);
      }
      deepScanForLeaks(value, `${path}.${key}`, found);
    }
  }
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

(async () => {
  await waitForServer();

  // A1 — no auth
  const unauth = await api('/admin/dashboard');
  check('A1 no-auth → 401', unauth.status === 401, `status=${unauth.status}`);

  // A2 — student → 403
  const student = await loginAs('seqquiz@localhost.test', 'SeqQuiz#2026');
  const studentDash = await api('/admin/dashboard', { cookie: student.cookie });
  check('A2 student → 403', studentDash.status === 403, `status=${studentDash.status} (data=${JSON.stringify(studentDash.data)?.slice(0, 120)})`);

  // A3 — admin → 200 + shape
  const admin = await loginAs(config.admin.email, config.admin.password);
  if (admin.status !== 200) throw new Error(`Admin login failed: ${JSON.stringify(admin.data)}`);
  check('A3 admin login → 200', admin.status === 200);
  if (!admin.cookie) throw new Error('Admin login returned no cookies (cookie-only auth required).');

  const dash = await api('/admin/dashboard', { cookie: admin.cookie });
  check('A3 dashboard → 200', dash.status === 200, `status=${dash.status}`);
  const d = dash.data;
  check('A3 envelope {success,data}', d && d.success === true && d.data, `success=${d?.success}`);
  if (d && d.data) {
    const c = d.data.counts;
    check('A3 counts numeric', ['students', 'admins', 'courses', 'enrollments', 'quizzes', 'newStudentsLast7d'].every((k) => typeof c[k] === 'number'), JSON.stringify(c));
    check('A3 attempts by status', c.attempts && typeof c.attempts.GRADING === 'number' && typeof c.attempts.GRADED === 'number', JSON.stringify(c.attempts));
    check('A3 videos by status (total+PENDING/PLAYABLE)', c.videos && typeof c.videos.total === 'number' && 'READY' in c.videos, JSON.stringify(c.videos));
    check('A3 alerts arrays', Array.isArray(d.data.alerts.failedVideos) && Array.isArray(d.data.alerts.stuckProcessingVideos) && Array.isArray(d.data.alerts.essaysPendingGrading), '');
    check('A3 recent arrays', Array.isArray(d.data.recent.users) && Array.isArray(d.data.recent.enrollments) && Array.isArray(d.data.recent.attempts), '');
  }

  // A4 — deep scan for sensitive fields
  const leaks = [];
  deepScanForLeaks(dash.data, 'payload', leaks);
  check('A4 no secret leaks', leaks.length === 0, leaks.length ? `LEAKS: ${leaks.join(', ')}` : 'clean');

  console.log(failures === 0 ? '\nALL PASS ✓' : `\n${failures} FAILURE(S) ✗`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});