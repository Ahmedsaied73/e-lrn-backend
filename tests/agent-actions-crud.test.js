'use strict';
/* Agent CRUD action contract tests (P2a: students + courses, NO deletes) — pure:
 * no DB, no Redis, no network.
 *
 * WHY this file is separate from agent-tools-contract.test.js: that suite pins the
 * CROSS-CUTTING contract (registry shape, approval gate, redaction) and the exact
 * approved catalogue. These four tools have per-tool semantics worth pinning one
 * by one — the field sets mirrored from the HTTP controllers, the structured
 * refusals (taken email/phone, unknown student/course, a vanished admin row) and
 * the hard rule that no credential material can ever leave a tool payload.
 *
 * Run: npm test
 */
const { describe, it, after, before } = require('node:test');
const assert = require('node:assert/strict');
const { actionDefinitions, getDefinition } = require('../src/services/agent/tools');
const { execute, AgentToolError } = require('../src/services/agent/tools/_kit');
const auditLog = require('../src/services/auditLog');
const { disconnectRedis } = require('../src/integrations/redis/redisClient');

const ARABIC_RE = /[\u0600-\u06FF]/;
const ADMIN_ID = 42;

// 12-char lowercase base36, the only identifier shape the platform issues.
const STUDENT_SLUG = 'stu123abc456';
const COURSE_SLUG = 'crs123abc456';

/**
 * Every mutating tool this phase added, with the audit action it must declare. The
 * deletes are listed LAST and kept in one block on purpose: they are the only
 * irreversible tools in the catalogue, and a reviewer scanning this file should see
 * immediately which ones they are.
 */
const CRUD_TOOLS = [
  { name: 'create_student', audit: 'USER_CREATE', target: 'user' },
  { name: 'update_student', audit: 'USER_UPDATE', target: 'user' },
  { name: 'create_course', audit: 'COURSE_CREATE', target: 'course' },
  { name: 'update_course', audit: 'COURSE_UPDATE', target: 'course' },
  { name: 'create_video', audit: 'VIDEO_CREATE', target: 'video' },
  { name: 'upsert_quiz', audit: 'QUIZ_UPSERT', target: 'quiz' },
  { name: 'delete_video', audit: 'VIDEO_DELETE', target: 'video', irreversible: true },
  { name: 'delete_quiz', audit: 'QUIZ_DELETE', target: 'quiz', irreversible: true },
  { name: 'delete_course', audit: 'COURSE_DELETE', target: 'course', irreversible: true },
  { name: 'delete_user', audit: 'USER_DELETE', target: 'user', irreversible: true },
];

const NEW_STUDENT_ARGS = {
  name: 'طالب جديد',
  email: 'new.student@example.com',
  password: 'StrongPass#2026',
  phoneNumber: '01001234567',
  grade: 'THIRD_SECONDARY',
};

const NEW_COURSE_ARGS = {
  title: 'دورة الأحياء',
  description: 'شرح كامل لمنهج الأحياء للصف الثالث الثانوي',
  priceEgp: 300,
  grade: 'THIRD_SECONDARY',
};

// Safety net copied from the cross-cutting suite: if a tool under test touches the
// cache, close the handle so the runner exits instead of hanging on an unreachable
// Redis socket.
after(async () => {
  await disconnectRedis();
});

const existingStudent = { id: 11, slug: STUDENT_SLUG, name: 'طالب قديم', grade: 'FIRST_SECONDARY', role: 'STUDENT' };
const existingCourse = { id: 22, slug: COURSE_SLUG, title: 'دورة الفيزياء', price: 250 };

/**
 * Minimal Prisma stand-in exposing ONLY the calls these four tools make — a call
 * the tool is not supposed to make is a loud TypeError, not a silent pass. Every
 * method records itself so a test can prove a refusal happened BEFORE the write
 * (e.g. no `user.create` after a duplicate-email refusal).
 */
function prismaStub(overrides = {}) {
  const {
    student = existingStudent,
    course = existingCourse,
    takenEmail = false,
    takenPhone = false,
    userCreateCode = null,
    userUpdateCode = null,
    courseCreateCode = null,
  } = overrides;

  const calls = [];
  const fail = (code) => Object.assign(new Error(`prisma ${code}`), { code });

  return {
    calls,
    user: {
      async findUnique(args) {
        calls.push({ model: 'user', op: 'findUnique', args });
        if (args.where.slug) return student && student.slug === args.where.slug ? student : null;
        if (args.where.email) return takenEmail ? { id: 1 } : null;
        if (args.where.phoneNumber) return takenPhone ? { id: 1 } : null;
        return null;
      },
      async create(args) {
        calls.push({ model: 'user', op: 'create', args });
        if (userCreateCode) throw fail(userCreateCode);
        return {
          id: 99,
          slug: 'newuser1a2b3',
          name: args.data.name,
          email: args.data.email,
          phoneNumber: args.data.phoneNumber,
          grade: args.data.grade,
          role: 'STUDENT',
        };
      },
      async update(args) {
        calls.push({ model: 'user', op: 'update', args });
        if (userUpdateCode) throw fail(userUpdateCode);
        return {
          id: args.where.id,
          slug: student.slug,
          name: args.data.name || student.name,
          grade: args.data.grade || student.grade,
          phoneNumber: args.data.phoneNumber || '01000000000',
        };
      },
    },
    course: {
      async findUnique(args) {
        calls.push({ model: 'course', op: 'findUnique', args });
        return course && course.slug === args.where.slug ? course : null;
      },
      async create(args) {
        calls.push({ model: 'course', op: 'create', args });
        if (courseCreateCode) throw fail(courseCreateCode);
        return {
          id: 77,
          slug: 'newcourse123',
          title: args.data.title,
          price: args.data.price,
          grade: args.data.grade,
          category: args.data.category || null,
        };
      },
      async update(args) {
        calls.push({ model: 'course', op: 'update', args });
        return {
          id: args.where.id,
          slug: course.slug,
          title: args.data.title || course.title,
          price: args.data.price !== undefined ? args.data.price : course.price,
          grade: args.data.grade || 'FIRST_SECONDARY',
          category: args.data.category || null,
        };
      },
    },
  };
}

const approved = (prisma) => ({ prisma, approved: true, adminId: ADMIN_ID });

describe('agent CRUD tools — catalogue contract', () => {
  it('registers the whole CRUD surface, deletes included', () => {
    const names = actionDefinitions.map((d) => d.name);
    for (const { name } of CRUD_TOOLS) {
      assert.ok(names.includes(name), `${name} is missing from the action catalogue`);
    }
    // The deletes shipped last by product decision, so their presence is asserted
    // explicitly rather than implied: this test failing means either a delete tool
    // was removed (fine, but then this list must say so) or the catalogue collapsed.
    for (const forbidden of ['delete_user', 'delete_course', 'delete_video', 'delete_quiz']) {
      const def = getDefinition(forbidden);
      assert.ok(def, `${forbidden} should now be registered`);
      // An irreversible tool the model cannot recognise as irreversible is the
      // failure mode that matters: the description must SAY so in Arabic.
      assert.match(def.description, /غير قابل للتراجع/, `${forbidden} must warn that it is irreversible`);
    }
  });

  it('every CRUD tool is an approval-gated, uncached, Arabic, audited action', () => {
    for (const { name, audit, target } of CRUD_TOOLS) {
      const def = getDefinition(name);
      assert.ok(def, `${name} not registered`);
      assert.equal(def.kind, 'action', `${name} kind`);
      assert.equal(def.requiresApproval, true, `${name} requiresApproval`);
      assert.equal(def.cacheTtlSeconds, 0, `${name} must never be cached`);
      assert.equal(def.audit.action, audit, `${name} audit action`);
      assert.equal(def.audit.targetType, target, `${name} audit target type`);
      assert.match(def.description, ARABIC_RE, `${name} description must be Arabic`);
      assert.ok(def.description.length >= 20, `${name} description must be explanatory`);
      // A tool the model cannot understand is a tool it will not call correctly:
      // every argument carries its own Arabic hint.
      for (const [key, field] of Object.entries(def.schema.shape || {})) {
        assert.match(field.description || '', ARABIC_RE, `${name}.${key} needs an Arabic .describe()`);
      }
    }
  });

  it('every new tool states in Arabic that admin approval is required', () => {
    for (const { name } of CRUD_TOOLS) {
      assert.match(getDefinition(name).description, /موافقة المشرف/, `${name} must announce the gate`);
    }
  });
});

/**
 * P2b semantics — the deletes and the quiz upsert.
 *
 * These run with NO database on purpose. A refusal that happens only after a query
 * is a different (and much weaker) guarantee than one that happens before it, so
 * every stub below THROWS on any call: reaching the database at all is the failure.
 */
describe('agent CRUD tools — P2b semantics', () => {
  /**
   * auditLog.record writes through the GLOBAL prisma client, so a suite that runs an
   * approved action would deposit real AuditLog rows in the shared database and turn
   * a "pure" test file into a data-writing one. It is swapped for a spy for the
   * duration of this block — which also makes the audit spec itself assertable.
   */
  const auditCalls = [];
  const realRecord = auditLog.record;
  before(() => {
    auditLog.record = async (req, spec) => {
      auditCalls.push(spec);
      return true;
    };
  });
  after(() => {
    auditLog.record = realRecord;
  });

  /** Any property access returns a function that throws: the DB must not be reached. */
  function forbiddenPrisma() {
    return new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('the database must not be reached in this test');
        },
      }
    );
  }

  const DELETE_ARGS = {
    delete_video: { videoSlug: 'vid123abc456' },
    delete_quiz: { quizSlug: 'qiz123abc456' },
    delete_course: { courseSlug: COURSE_SLUG },
    delete_user: { userSlug: STUDENT_SLUG },
  };

  it('every delete refuses without approval BEFORE it resolves its target', async () => {
    for (const [name, args] of Object.entries(DELETE_ARGS)) {
      await assert.rejects(
        () => execute(getDefinition(name), args, { prisma: forbiddenPrisma() }),
        (err) => err instanceof AgentToolError && err.code === 'APPROVAL_REQUIRED',
        `${name} must refuse an unapproved call`
      );
    }
  });

  it('delete_video does not touch Bunny when the slug matches nothing', async () => {
    const bunnyVideoService = require('../src/services/bunnyVideoService');
    const original = bunnyVideoService.deleteVideo;
    let destructiveCalls = 0;
    bunnyVideoService.deleteVideo = async () => {
      destructiveCalls += 1;
      return { id: 1, bunnyVideoId: 'x' };
    };
    try {
      const result = await execute(
        getDefinition('delete_video'),
        { videoSlug: 'missing123ab' },
        approved({ bunnyVideo: { findUnique: async () => null } })
      );
      assert.equal(result.data.ok, false);
      assert.equal(result.data.reason, 'VIDEO_NOT_FOUND');
      assert.equal(destructiveCalls, 0, 'an unknown slug must never reach the destructive call');
      // The refusal is still EVIDENCE: an attempt to delete a video is recorded
      // against the tool's own audit action, so a failed or mistaken request is
      // visible in the trail rather than silently disappearing.
      assert.equal(auditCalls.at(-1).action, 'VIDEO_DELETE');
      assert.equal(auditCalls.at(-1).targetType, 'video');
      assert.equal(auditCalls.at(-1).metadata.via, 'agent');
    } finally {
      bunnyVideoService.deleteVideo = original;
    }
  });

  it('delete_user refuses to delete the approving admin, and refuses a course owner', async () => {
    const self = await execute(
      getDefinition('delete_user'),
      { userSlug: STUDENT_SLUG },
      approved({
        user: { findUnique: async () => ({ id: ADMIN_ID, slug: STUDENT_SLUG, name: 'المشرف', role: 'ADMIN' }) },
      })
    );
    assert.equal(self.data.reason, 'CANNOT_DELETE_SELF');

    let transactionCalls = 0;
    const owner = await execute(
      getDefinition('delete_user'),
      { userSlug: STUDENT_SLUG },
      approved({
        user: { findUnique: async () => ({ id: 7, slug: STUDENT_SLUG, name: 'معلم', role: 'ADMIN' }) },
        course: { count: async () => 2 },
        $transaction: async () => {
          transactionCalls += 1;
          return [];
        },
      })
    );
    assert.equal(owner.data.reason, 'USER_OWNS_COURSES');
    assert.equal(owner.data.ownedCourses, 2, 'the refusal tells the admin what is blocking it');
    assert.equal(transactionCalls, 0, 'nothing may be deleted while a course still references the user');
  });

  it('upsert_quiz rejects an invalid SurveyJS document through the REAL validator', async () => {
    let upserts = 0;
    const result = await execute(
      getDefinition('upsert_quiz'),
      { videoSlug: 'vid123abc456', title: 'اختبار قصير', surveyJson: {}, answerKey: {} },
      approved({
        bunnyVideo: { findUnique: async () => ({ id: 5, title: 'فيديو' }) },
        quiz: {
          findUnique: async () => null,
          upsert: async () => {
            upserts += 1;
            return { id: 1 };
          },
        },
      })
    );
    assert.equal(result.data.ok, false);
    assert.equal(result.data.reason, 'INVALID_SURVEY_JSON');
    assert.ok(Array.isArray(result.data.details) && result.data.details.length > 0, 'the validator reason is surfaced');
    assert.equal(upserts, 0, 'an invalid definition must not be persisted');
  });

  it('create_student never returns credential material', async () => {
    const result = await execute(getDefinition('create_student'), NEW_STUDENT_ARGS, approved(prismaStub()));
    const flat = JSON.stringify(result.data);
    assert.equal(/password|hashed|\$2[aby]\$/.test(flat), false, `a credential leaked into a tool payload: ${flat}`);
    assert.equal(result.data.ok, true);
    assert.ok(result.data.student.slug, 'the created student is identified by slug');
  });

  it('a password passed as a tool argument never reaches the audit trail', async () => {
    await execute(getDefinition('create_student'), NEW_STUDENT_ARGS, approved(prismaStub()));
    const recorded = auditCalls.at(-1);
    assert.equal(recorded.action, 'USER_CREATE');
    // The audit helper only sanitizes its TOP-LEVEL keys, so a nested args.password
    // used to be written to AuditLog as plaintext. This is the regression pin: the
    // tool layer must redact credential arguments before recording them.
    const recordedArgs = JSON.stringify(recorded.metadata.args);
    assert.equal(recordedArgs.includes(NEW_STUDENT_ARGS.password), false, `password reached the audit row: ${recordedArgs}`);
    assert.equal(recorded.metadata.args.password, '[redacted]');
    // Non-secret arguments must survive, or the trail stops being useful.
    assert.equal(recorded.metadata.args.email, NEW_STUDENT_ARGS.email);
    assert.equal(recorded.metadata.args.grade, NEW_STUDENT_ARGS.grade);
  });
});

