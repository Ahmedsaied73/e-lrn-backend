'use strict';
/* BE quiz-lifecycle suite (node:test, no deps). Encodes the behaviors proven
 * live in the Q-5 + hide-until-pass runs. Requires the dev server on :3005.
 * Every test is net-zero: scratch users are cascade-deleted, quiz keys
 * restored byte-identical, exemptions revoked.
 *
 * Run: npm test
 */
process.chdir(__dirname + '/..');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createToken } = require('../src/utils.js');
const config = require('../src/config/env.js');
const { PrismaClient } = require('@prisma/client');

const API = process.env.TEST_BASE_URL || 'http://localhost:3005';
const prisma = new PrismaClient();
const adminCookie = () =>
  `accessToken=${createToken({ id: 1, email: 'admin@elearning.com', name: 'T', role: 'ADMIN' }, config.jwt.secret)}`;

async function req(method, path, cookie, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

async function makeStudent(tag) {
  const email = `seed-${tag}-${Date.now()}@localhost.test`;
  const stu = await prisma.user.create({ data: { name: 'Seed', email, password: 'x', grade: 'FIRST_SECONDARY' } });
  const cookie = `accessToken=${createToken({ id: stu.id, email, name: 'S', role: 'STUDENT' }, config.jwt.secret)}`;
  const admin = adminCookie();
  const enr = await req('POST', '/admin/enrollments', admin, { userId: stu.id, courseId: 1 });
  assert.equal(enr.status, 201, 'enroll fixture');
  const grant = await req('POST', '/quizzes/videos/1/exemptions', admin, { userId: stu.id, reason: 'seed' });
  assert.equal(grant.status, 200, 'exemption fixture');
  await req('POST', '/progress/complete', cookie, { videoId: 2 });
  return {
    stu, cookie,
    exId: grant.json.data.id,
    async cleanup() {
      const attempts = await prisma.quizAttempt.findMany({ where: { userId: stu.id }, select: { id: true } });
      for (const a of attempts) await req('POST', `/quizzes/attempts/${a.id}/reset`, admin, {});
      await req('DELETE', `/quizzes/exemptions/${this.exId}`, admin, {});
      const e = await prisma.enrollment.findFirst({ where: { userId: stu.id } });
      if (e) await req('DELETE', `/admin/enrollments/${e.id}`, admin, {});
      await prisma.user.delete({ where: { id: stu.id } });
      assert.equal(await prisma.quizAttempt.count({ where: { userId: stu.id } }), 0, 'net-zero attempts');
      assert.equal(await prisma.user.count({ where: { id: stu.id } }), 0, 'net-zero user');
    },
  };
}

describe('quiz lifecycle', () => {
  before(async () => {
    const r = await fetch(API + '/user/me');
    assert.equal(r.status, 401, 'server up (anon 401)');
  });
  after(async () => { await prisma.$disconnect(); });

  it('hide-until-pass: failed attempt reveals scores only, retake allowed', async () => {
    const fx = await makeStudent('hide');
    try {
      const start = await req('POST', '/quizzes/videos/2/start', fx.cookie, {});
      assert.equal(start.status, 200);
      const attId = start.json.data.attemptId;
      const sub = await req('POST', `/quizzes/attempts/${attId}/submit`, fx.cookie, { answers: { q1: 'الإسكندرية' } });
      assert.equal(sub.status, 200);
      assert.equal(sub.json.data.scorePercent, 0);
      assert.ok(!JSON.stringify(sub.json).includes('القاهرة'), 'submit leaks no answers');
      const res = await req('GET', `/quizzes/attempts/${attId}/result`, fx.cookie);
      assert.equal(res.status, 200);
      const q1 = res.json.data.questions.find((q) => q.name === 'q1');
      assert.equal(q1.correctAnswer, null);
      assert.equal(q1.isCorrect, false);
      assert.ok(!JSON.stringify(res.json).includes('القاهرة'), 'result leaks no answers');
      const retry = await req('POST', '/quizzes/videos/2/start', fx.cookie, {});
      assert.equal(retry.status, 200, 'retake allowed after fail');
      const retryId = retry.json.data.attemptId;
      await req('POST', `/quizzes/attempts/${retryId}/reset`, adminCookie(), {});
    } finally {
      await fx.cleanup();
    }
  });

  it('Q-5: mid-flight key edit cannot re-grade an in-flight attempt', async () => {
    const live0 = await prisma.quiz.findUnique({ where: { bunnyVideoId: 2 } });
    const fx = await makeStudent('snap');
    try {
      const start = await req('POST', '/quizzes/videos/2/start', fx.cookie, {});
      const attId = start.json.data.attemptId;
      const Kflip = JSON.parse(JSON.stringify(live0.answerKey));
      Kflip.q1.correctValue = 'الإسكندرية';
      const flip = await req('POST', '/quizzes/videos/2', adminCookie(),
        { title: live0.title, surveyJson: live0.surveyJson, answerKey: Kflip });
      assert.equal(flip.status, 200);
      try {
        const sub = await req('POST', `/quizzes/attempts/${attId}/submit`, fx.cookie, { answers: { q1: 'القاهرة' } });
        assert.equal(sub.json.data.scorePercent, 100, 'graded against frozen key');
        const res = await req('GET', `/quizzes/attempts/${attId}/result`, fx.cookie);
        const q1 = res.json.data.questions.find((q) => q.name === 'q1');
        assert.equal(q1.correctAnswer, 'القاهرة');
      } finally {
        const restore = await req('POST', '/quizzes/videos/2', adminCookie(),
          { title: live0.title, surveyJson: live0.surveyJson, answerKey: live0.answerKey });
        assert.equal(restore.status, 200);
        const back = await prisma.quiz.findUnique({ where: { bunnyVideoId: 2 } });
        assert.deepEqual(back.answerKey, live0.answerKey, 'key restored byte-identical');
      }
    } finally {
      await fx.cleanup();
    }
  });

  it('gates: passed quiz blocks retake, locked video denies playback', async () => {
    const seqCookie = `accessToken=${createToken({ id: 2, email: 'seqaccess@localhost.test', name: 'S', role: 'STUDENT' }, config.jwt.secret)}`;
    const start = await req('POST', '/quizzes/videos/1/start', seqCookie, {});
    assert.equal(start.status, 409);
    assert.equal(start.json.code, 'ALREADY_PASSED');
    const graderCookie = `accessToken=${createToken({ id: 3, email: 'grader-demo@localhost.test', name: 'G', role: 'STUDENT' }, config.jwt.secret)}`;
    const gate = await req('GET', '/videos/2/playback', graderCookie);
    assert.equal(gate.status, 403);
    assert.equal(gate.json.code, 'SEQUENTIAL_GATE');
  });
});
