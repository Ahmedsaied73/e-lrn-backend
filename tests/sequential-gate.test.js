'use strict';
/* BE sequential-gate suite (node:test, no deps). Proves the ordering rule the
 * whole product rests on: in an enrolled course the FIRST video is always
 * playable, and a LATER video stays locked until its prerequisites are met.
 *
 * Mirrors tests/quiz-lifecycle.test.js: scratch users are created through
 * Prisma, JWTs are minted locally, and every test is net-zero (progress,
 * exemptions, enrollment and the user row are deleted in after()).
 *
 * Fixture: course 1 with ≥2 READY videos (same demo fixture the rest of the
 * suite uses). Video order is read with the SAME ordering the gate uses
 * (`position asc, createdAt asc, id asc`, status READY) — never hardcoded.
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
const COURSE_ID = 1;
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
 * Course 1's READY videos, ranked exactly as evaluateGate ranks them.
 * Throws loudly if the fixture is missing — a silent pass on a wrong shape
 * would make this suite worthless.
 */
async function orderedVideos() {
  const course = await prisma.course.findUnique({
    where: { id: COURSE_ID },
    select: {
      slug: true,
      bunnyVideos: {
        where: { status: 'READY' },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, slug: true },
      },
    },
  });
  if (!course) throw new Error(`fixture course ${COURSE_ID} missing`);
  if (course.bunnyVideos.length < 2) {
    throw new Error('fixture course 1 needs ≥2 READY videos — cannot prove the sequential gate');
  }
  return { courseSlug: course.slug, first: course.bunnyVideos[0], second: course.bunnyVideos[1] };
}

/** Scratch student (+ optional enrollment), cleaned up by `purge`. */
async function makeStudent(tag, courseSlug, { enroll = true } = {}) {
  const email = `gate-${tag}-${Date.now()}@localhost.test`;
  const user = await prisma.user.create({
    data: { slug: randomBase36Slug(), name: 'Gate', email, password: 'x', grade: 'FIRST_SECONDARY' },
  });
  const cookie = `accessToken=${createToken({ id: user.id, email, name: 'G', role: 'STUDENT' }, config.jwt.secret)}`;
  if (enroll) {
    const enrolled = await req('POST', '/admin/enrollments', adminCookie(), { userSlug: user.slug, courseSlug });
    assert.equal(enrolled.status, 201, 'enroll fixture');
  }
  return { user, cookie };
}

/** Child-first delete — keeps the suite net-zero against the staging DB. */
async function purge(userId) {
  await prisma.bunnyVideoProgress.deleteMany({ where: { userId } });
  await prisma.gateExemption.deleteMany({ where: { userId } });
  await prisma.enrollment.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
  assert.equal(await prisma.bunnyVideoProgress.count({ where: { userId } }), 0, 'net-zero progress');
  assert.equal(await prisma.user.count({ where: { id: userId } }), 0, 'net-zero user');
}

describe('sequential gate', () => {
  let fx;
  const created = [];

  before(async () => { fx = await orderedVideos(); });

  after(async () => {
    for (const id of created) await purge(id);
    await prisma.$disconnect();
  });

  it('locks the second video until the first is completed', async () => {
    const stu = await makeStudent('lock', fx.courseSlug);
    created.push(stu.user.id);

    const res = await req('POST', '/progress/complete', stu.cookie, { videoSlug: fx.second.slug });
    assert.equal(res.status, 403, 'out-of-order completion is refused');
    assert.equal(res.json.code, 'VIDEO_NOT_UNLOCKED');
    assert.equal(res.json.previousVideoSlug, fx.first.slug, 'gate names the blocking video');
    assert.match(res.json.error, /previous video/i, 'reason explains the prerequisite');

    const rows = await prisma.bunnyVideoProgress.count({
      where: { userId: stu.user.id, bunnyVideoId: fx.second.id },
    });
    assert.equal(rows, 0, 'blocked completion wrote no progress row');
  });

  it('completes the first video (always accessible) and then unlocks the second', async () => {
    const stu = await makeStudent('unlock', fx.courseSlug);
    created.push(stu.user.id);

    const first = await req('POST', '/progress/complete', stu.cookie, { videoSlug: fx.first.slug });
    assert.equal(first.status, 200, 'first video is always accessible once enrolled');

    // Satisfy the previous video's quiz requirement. A GateExemption for the
    // previous video short-circuits the gate (quizService.js:354), so granting
    // it keeps this assertion deterministic whether or not video 1 has a quiz.
    const grant = await req('POST', `/quizzes/videos/${fx.first.slug}/exemptions`, adminCookie(), {
      userSlug: stu.user.slug,
      reason: 'sequential-gate suite',
    });
    assert.equal(grant.status, 200, 'exemption fixture');

    const second = await req('POST', '/progress/complete', stu.cookie, { videoSlug: fx.second.slug });
    assert.equal(second.status, 200, 'second video unlocks once prerequisites are met');

    const progress = await req('GET', `/progress/course/${fx.courseSlug}`, stu.cookie);
    assert.equal(progress.status, 200);
    assert.equal(progress.json.completedVideos, 2, 'both completions are recorded');
  });

  it('refuses a student who is not enrolled', async () => {
    const stu = await makeStudent('notenrolled', fx.courseSlug, { enroll: false });
    created.push(stu.user.id);

    const res = await req('POST', '/progress/complete', stu.cookie, { videoSlug: fx.first.slug });
    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'NOT_ENROLLED');
  });

  it('validates the video slug: malformed → 400, unknown → 404', async () => {
    const stu = await makeStudent('slugs', fx.courseSlug);
    created.push(stu.user.id);

    const malformed = await req('POST', '/progress/complete', stu.cookie, { videoSlug: 'notaslug' });
    assert.equal(malformed.status, 400, 'non-12-char slug is rejected before any lookup');

    const unknown = await req('POST', '/progress/complete', stu.cookie, { videoSlug: 'zzzzzzzzzzzy' });
    assert.equal(unknown.status, 404, 'well-formed slug that matches no video');
    assert.equal(unknown.json.code, 'VIDEO_NOT_FOUND');
  });
});

