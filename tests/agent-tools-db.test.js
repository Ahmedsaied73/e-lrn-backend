'use strict';
/* Agent tools — live-DB integration (Phase 1).
 *
 * The pure suites prove the contract; this one proves the Prisma queries are
 * real, the mutation guards hold against an actual database, and the audit rows
 * land. Net-zero by construction: every scratch row is created here and deleted
 * in after(), and the actions under test only ever touch scratch rows.
 *
 * Explicitly NOT covered here (would mutate shared fixtures): reordering a real
 * course's videos, killing a real video, broadcasting to real students. Those
 * are asserted through their guard paths instead.
 *
 * Run: npm test
 */
process.chdir(__dirname + '/..');
// This suite tests DATABASE behaviour. Redis is pinned OFF before any module
// reads config: the mutation paths legitimately call quizService cache
// invalidators, and against an unreachable Redis those arm ioredis retry timers
// that (a) make the run non-deterministic and (b) keep the test process alive
// after the last assertion. Caching itself is covered by the pure suites.
// Must be set before src/config/env.js is first required — dotenv never
// overrides a value already present in process.env.
process.env.REDIS_ENABLED = 'false';
// Good-citizen pool sizing: the repo's runner executes test FILES in parallel,
// and this suite issues bursts of aggregate queries. Giving it a small, explicit
// pool guarantees it can never starve the app-facing pool (default 20) that the
// heavyweight suites (payments, quiz lifecycle) are using at the same time.
process.env.DATABASE_CONNECTION_LIMIT = '5';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../src/config/db');
const { getDefinition } = require('../src/services/agent/tools');
const { execute } = require('../src/services/agent/tools/_kit');
const { randomBase36Slug } = require('../src/utils/slugs');
const { disconnectRedis } = require('../src/integrations/redis/redisClient');

let admin = null;
let student = null;
let course = null;
let video = null;

/** Definitions with caching disabled: a cached payload would make assertions
 *  depend on when a previous run populated Redis. */
function liveDef(name) {
  return { ...getDefinition(name), cacheTtlSeconds: 0 };
}

describe('agent tools — live DB (net-zero)', () => {
  before(async () => {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    admin = await prisma.user.create({
      data: {
        slug: randomBase36Slug(),
        name: 'Agent Admin',
        email: `agent-admin-${stamp}@localhost.test`,
        password: 'x',
        role: 'ADMIN',
        grade: 'FIRST_SECONDARY',
      },
    });
    student = await prisma.user.create({
      data: {
        slug: randomBase36Slug(),
        name: 'Agent Student',
        email: `agent-student-${stamp}@localhost.test`,
        phoneNumber: `0199${stamp.slice(-7)}`,
        password: 'x',
        grade: 'THIRD_SECONDARY',
      },
    });
    // Scratch course + video owned by the scratch admin: the suite never reads
    // or writes a shared fixture, so it cannot be perturbed by the other suites
    // that run in parallel against this database (and cannot perturb them).
    course = await prisma.course.create({
      data: {
        title: 'Agent Scratch Course',
        slug: randomBase36Slug(),
        description: 'Scratch course created by the agent tool suite.',
        thumbnail: 'scratch.png',
        price: 250,
        grade: 'FIRST_SECONDARY',
        teacherId: admin.id,
      },
      select: { id: true, slug: true, title: true, price: true },
    });
    video = await prisma.bunnyVideo.create({
      data: {
        courseId: course.id,
        title: 'Agent Scratch Video',
        slug: randomBase36Slug(),
        bunnyVideoId: `agent-scratch-${stamp}`,
        bunnyLibraryId: 'scratch',
        status: 'READY',
        position: 1,
      },
      select: { id: true, slug: true, status: true },
    });
  });

  after(async () => {
    await prisma.auditLog.deleteMany({ where: { actorId: admin.id } });
    await prisma.gateExemption.deleteMany({ where: { userId: student.id } });
    await prisma.enrollment.deleteMany({ where: { userId: student.id } });
    // Course before users: the scratch course holds the teacherId FK, and its
    // videos cascade with it.
    await prisma.course.deleteMany({ where: { id: course.id } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, student.id] } } });

    assert.equal(await prisma.user.count({ where: { id: { in: [admin.id, student.id] } } }), 0, 'net-zero users');
    assert.equal(await prisma.enrollment.count({ where: { userId: student.id } }), 0, 'net-zero enrollments');
    assert.equal(await prisma.course.count({ where: { id: course.id } }), 0, 'net-zero course');
    assert.equal(await prisma.bunnyVideo.count({ where: { id: video.id } }), 0, 'net-zero video');

    await prisma.$disconnect();
    await disconnectRedis();
  });

  it('runs real aggregates against the database', async () => {
    const overview = await execute(liveDef('platform_overview'), {}, { prisma });
    assert.ok(overview.data.users.students >= 1, 'student count is live');
    assert.ok(overview.data.users.admins >= 1, 'admin count is live');
    assert.ok(overview.data.enrollments.total >= 0, 'enrollment count is live');

    const byGrade = await execute(liveDef('students_count_by_grade'), { role: 'STUDENT' }, { prisma });
    const third = byGrade.data.byGrade.find((row) => row.grade === 'THIRD_SECONDARY');
    assert.ok(third && third.count >= 1, 'the scratch student appears in its grade bucket');
  });

  it('finds a student by name and masks the email in the payload', async () => {
    const result = await execute(liveDef('student_search'), { query: 'Agent Student', take: 10 }, { prisma });
    const mine = result.data.rows.find((row) => row.slug === student.slug);
    assert.ok(mine, 'scratch student is searchable by name');
    assert.match(mine.email, /^a\*\*\*@/, 'email is masked before leaving the tool');
    assert.equal(mine.phoneNumber, student.phoneNumber, 'phone is allowed through unchanged');
  });

  it('refuses an unattributable mutation and writes nothing', async () => {
    // Phase 3: the precondition is ATTRIBUTION, not an approval flag — a call
    // whose ctx carries no adminId must be refused before any write.
    const args = { userSlug: student.slug, courseSlug: course.slug };
    await assert.rejects(
      () => execute(liveDef('enroll_student'), args, { prisma }),
      (err) => err.code === 'ADMIN_REQUIRED'
    );
    assert.equal(
      await prisma.enrollment.count({ where: { userId: student.id } }),
      0,
      'the refusal happened before any write'
    );
  });

  it('enroll → duplicate → paid → unenroll round trip, with audit rows as evidence', async () => {
    const args = { userSlug: student.slug, courseSlug: course.slug };
    const ctx = { prisma, adminId: admin.id };

    const enrolled = await execute(liveDef('enroll_student'), args, ctx);
    assert.equal(enrolled.data.ok, true, 'enrolled');
    assert.equal(enrolled.data.isPaid, true, 'admin grants are paid (mirrors the HTTP path)');

    const stamped = await prisma.enrollment.findUnique({
      where: { userId_courseId: { userId: student.id, courseId: course.id } },
    });
    assert.ok(stamped, 'row really exists');

    const auditRow = await prisma.auditLog.findFirst({
      where: { actorId: admin.id, action: 'ENROLL_CREATE', targetId: stamped.id },
      orderBy: { id: 'desc' },
    });
    assert.ok(auditRow, 'ENROLL_CREATE audit row written');
    assert.equal(auditRow.metadata.via, 'agent', 'audit records that it came from the agent');
    assert.equal(auditRow.metadata.tool, 'enroll_student');

    const duplicate = await execute(liveDef('enroll_student'), args, ctx);
    assert.equal(duplicate.data.ok, false, 'duplicate refused');
    assert.equal(duplicate.data.reason, 'ALREADY_ENROLLED');

    const paid = await execute(liveDef('mark_enrollment_paid'), { ...args, expiresInDays: 30 }, ctx);
    assert.equal(paid.data.ok, true, 'marked paid');
    assert.equal(paid.data.after.expiresInDays, 30);
    assert.ok(paid.data.after.expiresAtIso, 'expiry stamped');

    const removed = await execute(liveDef('unenroll_student'), args, ctx);
    assert.equal(removed.data.ok, true, 'unenrolled');
    assert.equal(await prisma.enrollment.count({ where: { userId: student.id } }), 0, 'row gone');

    const again = await execute(liveDef('unenroll_student'), args, ctx);
    assert.equal(again.data.ok, false, 'second unenroll refused');
    assert.equal(again.data.reason, 'NOT_ENROLLED');
  });

  it('refuses unknown slugs on actions instead of throwing', async () => {
    const ctx = { prisma, adminId: admin.id };

    // Well-formed (12 base36 chars) but nonexistent → structured not-found.
    const missingStudent = await execute(
      liveDef('enroll_student'),
      { userSlug: 'zzzzzzzzzzz1', courseSlug: course.slug },
      ctx
    );
    assert.equal(missingStudent.data.reason, 'STUDENT_NOT_FOUND');

    const missingCourse = await execute(
      liveDef('enroll_student'),
      { userSlug: student.slug, courseSlug: 'zzzzzzzzzzz2' },
      ctx
    );
    assert.equal(missingCourse.data.reason, 'COURSE_NOT_FOUND');

    // Malformed identifier → rejected by the schema before any query runs.
    await assert.rejects(
      () => execute(liveDef('enroll_student'), { userSlug: 'u_not_a_slug', courseSlug: course.slug }, ctx),
      (err) => err.code === 'INVALID_ARGS',
      'a malformed slug never reaches the database'
    );
  });

  it('gate exemption grant/revoke round trip (needs a real video, else skips)', async (t) => {
    if (!video) return t.skip('no BunnyVideo fixture in this environment');
    const ctx = { prisma, adminId: admin.id };

    const granted = await execute(
      liveDef('grant_gate_exemption'),
      { userSlug: student.slug, videoSlug: video.slug, reason: 'اختبار أتمتة' },
      ctx
    );
    assert.equal(granted.data.ok, true, 'exemption granted');
    const exemptionId = granted.data.exemptionId;

    const revoked = await execute(liveDef('revoke_gate_exemption'), { exemptionId }, ctx);
    assert.equal(revoked.data.ok, true, 'exemption revoked');
    assert.equal(await prisma.gateExemption.count({ where: { userId: student.id } }), 0, 'row gone');
  });

  it('reports operational reads without throwing on sparse data', async () => {
    for (const name of [
      'enrollment_stats',
      'revenue_summary',
      'grading_backlog',
      'video_pipeline_status',
      'notification_stats',
      'admin_audit_recent',
      'essay_grading_turnaround',
      'ai_grading_stats',
    ]) {
      const result = await execute(liveDef(name), {}, { prisma });
      assert.ok(result.data && typeof result.data === 'object', `${name} returned a payload`);
      assert.equal(result.meta.tool, name);
    }
  });

  it('the audit trail is readable back through admin_audit_recent', async () => {
    const result = await execute(
      liveDef('admin_audit_recent'),
      { action: 'ENROLL_CREATE', windowDays: 1, take: 5 },
      { prisma }
    );
    assert.ok(result.data.rows.length >= 1, 'the enroll audit rows from this run are visible');
    assert.ok(result.data.rows.every((row) => row.action === 'ENROLL_CREATE'), 'filter respected');
    assert.ok(!('metadata' in result.data.rows[0]), 'raw metadata is never dumped into the payload');
  });

  it('course price action is guarded on both sides without touching shared data', async () => {
    const ctx = { prisma, adminId: admin.id };

    const missing = await execute(
      liveDef('update_course_price'),
      { courseSlug: 'zzzzzzzzzzz3', priceEgp: 100 },
      ctx
    );
    assert.equal(missing.data.reason, 'COURSE_NOT_FOUND');

    // Price captured immediately before the call: the assertion registers a
    // no-op, so it can never write to (or depend on) another suite's fixture.
    const fresh = await prisma.course.findUnique({ where: { id: course.id }, select: { price: true } });
    const same = await execute(
      liveDef('update_course_price'),
      { courseSlug: course.slug, priceEgp: fresh.price },
      ctx
    );
    assert.equal(same.data.ok, true);
    assert.equal(same.data.unchanged, true, 'a no-op price change reports unchanged instead of writing');
    const afterRow = await prisma.course.findUnique({ where: { id: course.id }, select: { price: true } });
    assert.equal(afterRow.price, fresh.price, 'fixture price untouched');
  });
});
