'use strict';
// M1 verify (limiter-proof): Prisma-created scratch student + forged tokens.
process.chdir('H:/e-learning-platform');
const crypto = require('crypto');
const { createToken } = require('H:/e-learning-platform/src/utils.js');
const { randomBase36Slug } = require('H:/e-learning-platform/src/utils/slugs.js');
const config = require('H:/e-learning-platform/src/config/env.js');
const { PrismaClient } = require('H:/e-learning-platform/node_modules/@prisma/client');
const prisma = new PrismaClient();
const API = 'http://localhost:3005';
const forge = (id, email, role) => `accessToken=${createToken({ id, email, name: 'Probe', role }, config.jwt.secret)}`;
const adminH = { Cookie: forge(1, 'admin@elearning.com', 'ADMIN'), 'Content-Type': 'application/json' };
async function call(method, path, body = null, headers = adminH) {
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(true); console.log('PASS', name); }
  catch (e) { results.push(false); console.log('FAIL', name, '—', e.message); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const stamp = Date.now().toString(36);
let courseSlug = null;
let student = null;
let studentH = null;
(async () => {
  try {
    await check('scratch student (Prisma) + forged token', async () => {
      student = await prisma.user.create({
        data: { slug: randomBase36Slug(), name: 'Notif Probe', email: `notifprobe-${stamp}@localhost.test`, password: 'x', phoneNumber: `010999${stamp.slice(-5)}`, grade: 'FIRST_SECONDARY', role: 'STUDENT' },
      });
      studentH = { Cookie: forge(student.id, student.email, 'STUDENT'), 'Content-Type': 'application/json' };
      const me = await call('GET', '/user/me', null, studentH);
      assert(me.status === 200, 'me ' + me.status);
    });

    await check('scratch course + enroll (isolation boundary)', async () => {
      const c = await call('POST', '/courses', { title: 'Notif Isolation', description: 'd', price: 0, grade: 'FIRST_SECONDARY' });
      assert([200, 201].includes(c.status), 'create course ' + c.status);
      courseSlug = c.data.data.slug;
      const e = await call('POST', '/enroll', { courseSlug }, studentH);
      assert([200, 201].includes(e.status), 'enroll ' + e.status);
    });

    let notifId = null;
    await check('broadcast to course reaches only the student', async () => {
      const b = await call('POST', '/notifications/broadcast', { title: 'Hello', body: 'World', audience: { kind: 'course', courseSlug } });
      assert(b.status === 201, 'broadcast ' + b.status);
      assert(b.data.data.count === 1, 'exactly 1, got ' + b.data.data.count);
      const l = await call('GET', '/notifications', null, studentH);
      assert(l.status === 200 && l.data.data.total === 1, 'student sees 1');
      notifId = l.data.data.items[0].id;
    });

    await check('unread-count + mark one read', async () => {
      const u1 = await call('GET', '/notifications/unread-count', null, studentH);
      assert(u1.data.data.count === 1, 'count 1');
      const m = await call('PATCH', `/notifications/${notifId}/read`, {}, studentH);
      assert(m.data.data.updated === 1, 'marked');
      const u2 = await call('GET', '/notifications/unread-count', null, studentH);
      assert(u2.data.data.count === 0, 'count 0');
    });

    await check('isolation: foreign mark returns 0, row untouched', async () => {
      await call('POST', '/notifications/broadcast', { title: 'Again', audience: { kind: 'course', courseSlug } });
      const l = await call('GET', '/notifications?unreadOnly=true', null, studentH);
      const m = await call('PATCH', `/notifications/${l.data.data.items[0].id}/read`);
      assert(m.data.data.updated === 0, 'admin gets 0');
      const u = await call('GET', '/notifications/unread-count', null, studentH);
      assert(u.data.data.count === 1, 'still unread');
      await call('PATCH', '/notifications/read-all', {}, studentH);
    });

    await check('validation rejects bad input', async () => {
      assert((await call('POST', '/notifications/broadcast', { body: 'x', audience: { kind: 'all' } })).status === 400, 'no title');
      assert((await call('POST', '/notifications/broadcast', { title: 't', linkUrl: 'https://evil.test/x', audience: { kind: 'all' } })).status === 400, 'ext link');
      assert((await call('POST', '/notifications/broadcast', { title: 't', audience: { kind: 'planet' } })).status === 400, 'bad aud');
      assert((await call('POST', '/notifications/broadcast', { title: 't', audience: { kind: 'course', courseSlug: 'dddddddddddd' } })).status === 404, 'no course');
      assert((await call('PATCH', '/notifications/abc/read', {}, studentH)).status === 400, 'bad id');
    });

    await check('unauthenticated blocked', async () => {
      assert((await fetch(API + '/notifications')).status === 401, 'anon 401');
    });
  } finally {
    if (courseSlug) await call('DELETE', `/courses/${courseSlug}`);
    if (student) await prisma.user.delete({ where: { id: student.id } }).catch(() => {});
    await prisma.$disconnect();
    console.log('cleanup done');
  }
  if (results.some((r) => !r)) process.exit(1);
  console.log('NOTIF API GREEN');
  process.exit(0);
})().catch(async (e) => { console.error('ERROR:', e.message); try { await prisma.$disconnect(); } catch {} process.exit(1); });
