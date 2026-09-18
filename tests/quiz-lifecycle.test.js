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
const { opaqueUserSlug } = require('../src/utils/slugs.js');
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

/**
 * Pick the first MCQ with ≥2 choices from a live quiz row.
 * Returns { q, correct, wrong }. Throws loudly if the fixture quiz has no
 * MCQ — the suite must fail visibly, never silently pass on a wrong shape.
 */
function pickMcq(live) {
  const key = (live && live.answerKey) || {};
  const pages = ((live && live.surveyJson && live.surveyJson.pages) || []);
  for (const page of pages) {
    for (const el of (page.elements || [])) {
      if (!el || el.type !== 'radiogroup') continue;
      const entry = key[el.name];
      if (!entry || entry.correctValue === undefined || entry.correctValue === null) continue;
      const values = (el.choices || []).map((c) => (c && typeof c === 'object' ? c.value : c));
      const wrong = values.find((v) => String(v) !== String(entry.correctValue));
      if (wrong === undefined) continue;
      return { q: el.name, correct: entry.correctValue, wrong };
    }
  }
  throw new Error('fixture quiz 2 has no MCQ with ≥2 choices — cannot prove grading/hiding');
}

async function makeStudent(tag) {
  const email = `seed-${tag}-${Date.now()}@localhost.test`;
  const stu = await prisma.user.create({ data: { slug: opaqueUserSlug(), name: 'Seed', email, password: 'x', grade: 'FIRST_SECONDARY' } });
  const cookie = `accessToken=${createToken({ id: stu.id, email, name: 'S', role: 'STUDENT' }, config.jwt.secret)}`;
  const admin = adminCookie();
  const enr = await req('POST', '/admin/enrollments', admin, { userSlug: stu.slug, courseSlug: 'course-1' });
  assert.equal(enr.status, 201, 'enroll fixture');
  const grant = await req('POST', '/quizzes/videos/video-1/exemptions', admin, { userSlug: stu.slug, reason: 'seed' });
  assert.equal(grant.status, 200, 'exemption fixture');
  await req('POST', '/progress/complete', cookie, { videoSlug: 'video-2' });
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
    // Fixture-independent: derive a wrong answer from the LIVE key (quiz 2 is
    // re-authorable via admin UI; hardcoding choices rotted this test before).
    const live = await prisma.quiz.findUnique({ where: { bunnyVideoId: 2 } });
    const target = pickMcq(live);
    const fx = await makeStudent('hide');
    try {
      const start = await req('POST', '/quizzes/videos/video-2/start', fx.cookie, {});
      assert.equal(start.status, 200);
      const attId = start.json.data.attemptId;
      const sub = await req('POST', `/quizzes/attempts/${attId}/submit`, fx.cookie, { answers: { [target.q]: target.wrong } });
      assert.equal(sub.status, 200);
      assert.ok(sub.json.data.scorePercent < live.passingScore, 'attempt failed');
      // Guard the real leak vectors, not raw string containment: a failed
      // attempt must expose neither the answerKey object nor the correctValue
      // field (submitting the raw correct value appears in answer-bearing
      // fields only; timestamps/IDs legitimately contain answer values as
      // substrings, so `includes(correct)` would flake).
      assert.ok(!JSON.stringify(sub.json).includes('answerKey'), 'submit leaks answerKey');
      assert.ok(!JSON.stringify(sub.json).includes('correctValue'), 'submit leaks correctValue');
      const res = await req('GET', `/quizzes/attempts/${attId}/result`, fx.cookie);
      assert.equal(res.status, 200);
      const q = res.json.data.questions.find((x) => x.name === target.q);
      assert.equal(q.correctAnswer, null);
      assert.equal(q.isCorrect, false);
      assert.ok(!JSON.stringify(res.json).includes('answerKey'), 'result leaks answerKey');
      assert.ok(!JSON.stringify(res.json).includes('correctValue'), 'result leaks correctValue');
      const retry = await req('POST', '/quizzes/videos/video-2/start', fx.cookie, {});
      assert.equal(retry.status, 200, 'retake allowed after fail');
      const retryId = retry.json.data.attemptId;
      await req('POST', `/quizzes/attempts/${retryId}/reset`, adminCookie(), {});
    } finally {
      await fx.cleanup();
    }
  });

  it('Q-5: mid-flight key edit cannot re-grade an in-flight attempt', async () => {
    // Fixture-independent: flip the live correct value, submit the ORIGINAL
    // answer, prove grading + review honor the frozen start-time key.
    const live0 = await prisma.quiz.findUnique({ where: { bunnyVideoId: 2 } });
    const target = pickMcq(live0);
    const fx = await makeStudent('snap');
    try {
      const start = await req('POST', '/quizzes/videos/video-2/start', fx.cookie, {});
      const attId = start.json.data.attemptId;
      const Kflip = JSON.parse(JSON.stringify(live0.answerKey));
      Kflip[target.q].correctValue = target.wrong;
      const flip = await req('POST', '/quizzes/videos/video-2', adminCookie(),
        { title: live0.title, surveyJson: live0.surveyJson, answerKey: Kflip });
      assert.equal(flip.status, 200);
      try {
        const sub = await req('POST', `/quizzes/attempts/${attId}/submit`, fx.cookie, { answers: { [target.q]: target.correct } });
        assert.equal(sub.status, 200);
        const pq = sub.json.data.perQuestion.find((x) => x.qName === target.q);
        assert.ok(pq && pq.isCorrect === true && pq.earned === pq.max, 'graded against frozen key');
        const res = await req('GET', `/quizzes/attempts/${attId}/result`, fx.cookie);
        const q = res.json.data.questions.find((x) => x.name === target.q);
        const st = res.json.data.status;
        const showAnswers = st === 'GRADED' && (res.json.data.scorePercent || 0) >= live0.passingScore;
        assert.equal(q.correctAnswer, showAnswers ? target.correct : null, 'review honors frozen key + hide-until-pass');
        assert.equal(q.isCorrect, true);
      } finally {
        const restore = await req('POST', '/quizzes/videos/video-2', adminCookie(),
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
    const start = await req('POST', '/quizzes/videos/video-1/start', seqCookie, {});
    assert.equal(start.status, 409);
    assert.equal(start.json.code, 'ALREADY_PASSED');
    const graderCookie = `accessToken=${createToken({ id: 3, email: 'grader-demo@localhost.test', name: 'G', role: 'STUDENT' }, config.jwt.secret)}`;
    const gate = await req('GET', '/videos/video-2/playback', graderCookie);
    assert.equal(gate.status, 403);
    assert.equal(gate.json.code, 'SEQUENTIAL_GATE');
  });
});
