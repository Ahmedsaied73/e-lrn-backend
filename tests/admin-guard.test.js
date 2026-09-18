'use strict';
/* BE admin-guard suite (node:test, no deps). Pins the role boundary and the
 * admin-console leak rule:
 *   - unauthenticated → 401, student → 403 on every /admin surface;
 *   - malformed user slug → 400, well-formed-but-unknown → 404;
 *   - admin serializers never carry answerKey / refreshToken / password.
 *
 * Net-zero: the scratch student is deleted in after().
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
  return { status: res.status, json, raw: JSON.stringify(json) };
}

let student = null;

describe('admin guard + leak rule', () => {
  before(async () => {
    const email = `adminguard-${Date.now()}@localhost.test`;
    const user = await prisma.user.create({
      data: { slug: randomBase36Slug(), name: 'Guard', email, password: 'x', grade: 'FIRST_SECONDARY' },
    });
    student = {
      user,
      cookie: `accessToken=${createToken({ id: user.id, email, name: 'G', role: 'STUDENT' }, config.jwt.secret)}`,
    };
  });

  after(async () => {
    await prisma.user.delete({ where: { id: student.user.id } });
    assert.equal(await prisma.user.count({ where: { id: student.user.id } }), 0, 'net-zero user');
    await prisma.$disconnect();
  });

  it('rejects unauthenticated calls with 401', async () => {
    for (const path of ['/admin/dashboard', '/admin/quizzes', '/admin/attempts', '/admin/enrollments']) {
      const res = await req('GET', path, null);
      assert.equal(res.status, 401, `${path} requires authentication`);
    }
  });

  it('rejects student calls with 403 on every admin surface', async () => {
    for (const path of ['/admin/dashboard', '/admin/quizzes', '/admin/attempts', '/admin/enrollments']) {
      const res = await req('GET', path, student.cookie);
      assert.equal(res.status, 403, `${path} is ADMIN-only`);
    }
  });

  it('validates the user slug: malformed → 400, unknown → 404', async () => {
    const malformed = await req('PUT', '/user/notaslug', adminCookie(), { name: 'Nope' });
    assert.equal(malformed.status, 400, 'a non-12-char slug never reaches the database');
    assert.match(malformed.json.error, /invalid user slug/i);

    const unknown = await req('PUT', '/user/zzzzzzzzzzzy', adminCookie(), { name: 'Nope' });
    assert.equal(unknown.status, 404, 'well-formed slug that matches no user');
  });

  it('serves the admin console to an ADMIN and leaks no secrets', async () => {
    const dash = await req('GET', '/admin/dashboard', adminCookie());
    assert.equal(dash.status, 200, 'admin reaches the dashboard');

    for (const path of ['/admin/quizzes', '/admin/attempts', '/admin/enrollments']) {
      const res = await req('GET', path, adminCookie());
      assert.equal(res.status, 200, `${path} is readable by an admin`);
      assert.ok(!res.raw.includes('answerKey'), `${path} must not serialize answerKey`);
      assert.ok(!res.raw.includes('"password"'), `${path} must not serialize password`);
      assert.ok(!res.raw.includes('refreshToken'), `${path} must not serialize refreshToken`);
    }
  });
});
