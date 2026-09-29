'use strict';
/* Agent CRUD action contract tests — pure: no DB, no Redis, no network.
 *
 * WHY this file is separate from agent-tools-contract.test.js: that suite pins the
 * CROSS-CUTTING contract (registry shape, attribution/confirmation gates, redaction)
 * and the catalogue. These tools have per-tool semantics worth pinning one by one —
 * the field sets mirrored from the HTTP controllers, the structured refusals (taken
 * email/phone, unknown student/course), the two-step preview→confirm flow of the
 * destructive tools (Phase 3), and the hard rule that no credential material can
 * ever leave a tool payload.
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
 * irreversible tools in the catalogue, and Phase 3 makes that structural — kind
 * 'confirm' means the tool previews first and only executes with a token its own
 * preview issued.
 */
const CRUD_TOOLS = [
  { name: 'create_student', audit: 'USER_CREATE', target: 'user' },
  { name: 'update_student', audit: 'USER_UPDATE', target: 'user' },
  { name: 'create_course', audit: 'COURSE_CREATE', target: 'course' },
  { name: 'update_course', audit: 'COURSE_UPDATE', target: 'course' },
  { name: 'upsert_quiz', audit: 'QUIZ_UPSERT', target: 'quiz' },
  { name: 'delete_video', audit: 'VIDEO_DELETE', target: 'video', irreversible: true, kind: 'confirm' },
  { name: 'delete_quiz', audit: 'QUIZ_DELETE', target: 'quiz', irreversible: true, kind: 'confirm' },
  { name: 'delete_course', audit: 'COURSE_DELETE', target: 'course', irreversible: true, kind: 'confirm' },
  { name: 'delete_user', audit: 'USER_DELETE', target: 'user', irreversible: true, kind: 'confirm' },
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

// Phase 3 (Decision #1): an attributable admin id is the ONLY precondition a plain
// action needs — the legacy `approved: true` flag is gone from the tool layer. The
// destructive (kind 'confirm') tools additionally require a confirmationToken their
// own preview issued; those flows build their ctx explicitly below.
const approved = (prisma) => ({ prisma, adminId: ADMIN_ID });

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

  it('every CRUD tool is immediate-or-confirmable, uncached, Arabic, audited', () => {
    for (const { name, audit, target, kind = 'action' } of CRUD_TOOLS) {
      const def = getDefinition(name);
      assert.ok(def, `${name} not registered`);
      assert.equal(def.kind, kind, `${name} kind`);
      // Phase 3: the static approval gate is GONE. Pinning its absence keeps the
      // "tools exist but no schema ever reached the model" door closed — a
      // resurrected requiresApproval:true would again make mutations silently dead.
      assert.equal(def.requiresApproval, false, `${name} must not claim the removed approval gate`);
      assert.equal(def.cacheTtlSeconds, 0, `${name} must never be cached`);
      assert.equal(def.audit.action, audit, `${name} audit action`);
      assert.equal(def.audit.targetType, target, `${name} audit target type`);
      assert.match(def.description, ARABIC_RE, `${name} description must be Arabic`);
      assert.ok(def.description.length >= 20, `${name} description must be explanatory`);
      if (kind === 'confirm') {
        // The two-step contract lives IN the definition: a read-only preview, and
        // a token field the model is allowed to carry back.
        assert.equal(typeof def.preview, 'function', `${name} must expose a read-only preview`);
        assert.ok(def.schema.shape.confirmationToken, `${name} model schema must expose confirmationToken`);
      }
      // A tool the model cannot understand is a tool it will not call correctly:
      // every argument carries its own Arabic hint.
      for (const [key, field] of Object.entries(def.schema.shape || {})) {
        assert.match(field.description || '', ARABIC_RE, `${name}.${key} needs an Arabic .describe()`);
      }
    }
  });

  it('descriptions state the Phase 3 contract: immediate for actions, two steps for deletes', () => {
    for (const { name, irreversible } of CRUD_TOOLS) {
      const desc = getDefinition(name).description;
      // The removed approval flow must not be PROMISED anywhere: a description
      // telling the model to wait for an approval gate re-creates the old dead end
      // where the tool existed but the flow never completed.
      assert.equal(desc.includes('موافقة المشرف'), false, `${name} must not promise the removed approval gate`);
      if (irreversible) {
        assert.match(desc, /خطوتين/, `${name} must announce the two-step preview/confirm flow`);
      } else {
        assert.match(desc, /ينفّذ فورا/, `${name} must announce immediate execution`);
      }
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

  it('every delete refuses an unattributable call BEFORE it resolves its target', async () => {
    // Phase 3 replaced the approval flag with ATTRIBUTION: a mutation with no real
    // admin behind it is not allowed to happen — and the refusal must precede every
    // query, so even the read-only preview never runs against an unknown caller.
    for (const [name, args] of Object.entries(DELETE_ARGS)) {
      await assert.rejects(
        () => execute(getDefinition(name), args, { prisma: forbiddenPrisma() }),
        (err) => err instanceof AgentToolError && err.code === 'ADMIN_REQUIRED',
        `${name} must refuse a call it cannot attribute to an admin`
      );
    }
  });

  /**
   * AgentApproval stand-in for the confirm flow — the same CAS state machine
   * Postgres runs (only one caller can flip PENDING), with no database. Rows are
   * created through the REAL requestApproval() the preview path calls, so
   * argsHash/expiresAt come from production code, not from hand-written fixtures.
   */
  function approvalStub() {
    const rows = new Map();
    let nextId = 901;
    return {
      rows,
      agentApproval: {
        async create({ data }) {
          const row = { id: nextId, ...data };
          rows.set(nextId, row);
          nextId += 1;
          return row;
        },
        async findUnique({ where }) {
          return rows.get(where.id) || null;
        },
        async updateMany({ where, data }) {
          const row = rows.get(where.id);
          if (!row || (where.status !== undefined && row.status !== where.status)) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      },
    };
  }

  /** Prisma whose ONLY reachable model is agentApproval: a refused confirmation
   *  that went on to resolve its target would throw instead of passing. */
  function gateOnlyPrisma(stub) {
    return new Proxy(stub, {
      get: (target, prop) =>
        prop in target
          ? target[prop]
          : () => {
              throw new Error('a refused confirmation must never resolve its target');
            },
    });
  }

  const VIDEO_ARGS = { videoSlug: 'vid123abc456' };
  const previewableVideo = {
    id: 5,
    slug: VIDEO_ARGS.videoSlug,
    title: 'فيديو',
    status: 'READY',
    course: { title: 'دورة' },
    quiz: { title: 'اختبار' },
    _count: { progress: 12 },
  };

  /** Preview delete_video through the real path and hand back the stub, token, result. */
  async function issuedVideoToken() {
    const stub = approvalStub();
    const prisma = { ...stub, bunnyVideo: { findUnique: async () => previewableVideo } };
    const result = await execute(getDefinition('delete_video'), VIDEO_ARGS, { prisma, adminId: ADMIN_ID });
    return { stub, token: result.data.confirmationToken, result };
  }

  it('a no-token call PREVIEWs, issues one PENDING token, and mutates nothing', async () => {
    const { stub, token, result } = await issuedVideoToken();
    assert.match(token, /^\d+$/, 'the token is the AgentApproval row id as a string');
    assert.equal(result.data.ok, true);
    assert.equal(result.data.stage, 'PREVIEW');
    assert.equal(result.data.confirmationRequired, true);
    assert.ok(Date.parse(result.data.confirmationExpiresAt) > Date.now(), 'the token carries a future expiry');
    assert.equal(result.data.preview.target.video.studentProgressRows, 12, 'the admin sees the real blast radius');
    assert.equal(result.data.preview.irreversible, true);
    assert.equal(stub.rows.size, 1, 'exactly one row becomes pending');
    assert.equal(stub.rows.get(Number(token)).status, 'PENDING');
    assert.equal(stub.rows.get(Number(token)).adminId, ADMIN_ID, 'the token is bound to the requesting admin');
    assert.equal(auditCalls.at(-1).metadata.stage, 'preview', 'the preview itself is evidence');
  });

  it('a preview refusal is the answer: no token, nothing pending', async () => {
    const stub = approvalStub();
    const result = await execute(getDefinition('delete_video'), { videoSlug: 'missing123ab' }, {
      prisma: { ...stub, bunnyVideo: { findUnique: async () => null } },
      adminId: ADMIN_ID,
    });
    assert.equal(result.data.ok, false);
    assert.equal(result.data.reason, 'VIDEO_NOT_FOUND');
    assert.equal(result.data.confirmationToken, undefined);
    assert.equal(stub.rows.size, 0, 'there is nothing to confirm, so no token may exist');
  });

  it('confirming the exact previewed args executes exactly once, and the spent token cannot replay', async () => {
    const bunnyVideoService = require('../src/services/bunnyVideoService');
    const original = bunnyVideoService.deleteVideo;
    let destructiveCalls = 0;
    bunnyVideoService.deleteVideo = async () => {
      destructiveCalls += 1;
      return { id: 5, bunnyVideoId: 'bunny-9' };
    };
    try {
      const stub = approvalStub();
      const ctx = {
        prisma: { ...stub, bunnyVideo: { findUnique: async () => previewableVideo } },
        adminId: ADMIN_ID,
      };
      const preview = await execute(getDefinition('delete_video'), VIDEO_ARGS, ctx);
      assert.equal(destructiveCalls, 0, 'the preview call must not delete');

      const done = await execute(
        getDefinition('delete_video'),
        { ...VIDEO_ARGS, confirmationToken: preview.data.confirmationToken },
        ctx
      );
      assert.equal(done.data.ok, true);
      assert.equal(done.data.video.bunnyVideoId, 'bunny-9');
      assert.equal(destructiveCalls, 1);
      assert.equal(auditCalls.at(-1).metadata.stage, 'confirmed');
      assert.equal(stub.rows.get(Number(preview.data.confirmationToken)).status, 'CONSUMED');

      const replay = await execute(
        getDefinition('delete_video'),
        { ...VIDEO_ARGS, confirmationToken: preview.data.confirmationToken },
        ctx
      );
      assert.equal(replay.data.ok, false);
      assert.equal(replay.data.reason, 'CONFIRMATION_MISMATCH');
      assert.equal(destructiveCalls, 1, 'a spent token must never delete twice');
    } finally {
      bunnyVideoService.deleteVideo = original;
    }
  });

  it('the confirm path refuses every stale token BEFORE resolving the target', async () => {
    // Foreign admin and unknown id → NOT_FOUND (no ownership oracle; and the
    // gate-only prisma THROWS if a refused call dares to look the video up).
    const { stub, token } = await issuedVideoToken();
    const foreign = await execute(getDefinition('delete_video'), { ...VIDEO_ARGS, confirmationToken: token }, {
      prisma: gateOnlyPrisma(stub),
      adminId: 777,
    });
    assert.equal(foreign.data.reason, 'CONFIRMATION_NOT_FOUND');

    const ghost = await execute(getDefinition('delete_video'), { ...VIDEO_ARGS, confirmationToken: '999999' }, {
      prisma: gateOnlyPrisma(stub),
      adminId: ADMIN_ID,
    });
    assert.equal(ghost.data.reason, 'CONFIRMATION_NOT_FOUND');

    // A token issued for a DIFFERENT tool must not authorise this one.
    const crossed = await issuedVideoToken();
    crossed.stub.rows.get(Number(crossed.token)).toolName = 'delete_course';
    const hijack = await execute(getDefinition('delete_video'), { ...VIDEO_ARGS, confirmationToken: crossed.token }, {
      prisma: gateOnlyPrisma(crossed.stub),
      adminId: ADMIN_ID,
    });
    assert.equal(hijack.data.reason, 'CONFIRMATION_MISMATCH');

    // Expiry: refused, and the row's bookkeeping still flips to EXPIRED.
    const stale = await issuedVideoToken();
    stale.stub.rows.get(Number(stale.token)).expiresAt = new Date(Date.now() - 1000);
    const expired = await execute(getDefinition('delete_video'), { ...VIDEO_ARGS, confirmationToken: stale.token }, {
      prisma: gateOnlyPrisma(stale.stub),
      adminId: ADMIN_ID,
    });
    assert.equal(expired.data.reason, 'CONFIRMATION_EXPIRED');
    assert.equal(stale.stub.rows.get(Number(stale.token)).status, 'EXPIRED');

    // Args drift: the token authorises the HASH of what was previewed, nothing else.
    const drifted = await issuedVideoToken();
    const moved = await execute(
      getDefinition('delete_video'),
      { videoSlug: 'oth123abc456', confirmationToken: drifted.token },
      { prisma: gateOnlyPrisma(drifted.stub), adminId: ADMIN_ID }
    );
    assert.equal(moved.data.reason, 'CONFIRMATION_MISMATCH');

    // A malformed token never reaches the gate at all — the schema refuses it first.
    await assert.rejects(
      () =>
        execute(getDefinition('delete_video'), { ...VIDEO_ARGS, confirmationToken: 'abc' }, {
          prisma: gateOnlyPrisma(approvalStub()),
          adminId: ADMIN_ID,
        }),
      (err) => err instanceof AgentToolError && err.code === 'INVALID_ARGS',
      'a non-numeric token must be rejected as an argument error'
    );
  });

  it('broadcast_notification previews the REAL audience and only tokens a sendable one', async () => {
    const notificationService = require('../src/services/notifications/notificationService');
    const original = notificationService.resolveAudience;
    notificationService.resolveAudience = async () => [1, 2, 3];
    try {
      const args = { title: 'صيانة الأسبوع', audience: { kind: 'all' }, expectedRecipients: 3 };
      const ctx = { prisma: approvalStub(), adminId: ADMIN_ID };

      const preview = await execute(getDefinition('broadcast_notification'), args, ctx);
      assert.equal(preview.data.stage, 'PREVIEW');
      assert.equal(preview.data.preview.recipients, 3, 'the admin confirms against the real count');

      // Audience drift is NOT a blank cheque: run() re-resolves the audience and
      // still enforces expectedRecipients, so a preview token cannot over-send.
      notificationService.resolveAudience = async () => [1, 2, 3, 4];
      const drift = await execute(
        getDefinition('broadcast_notification'),
        { ...args, confirmationToken: preview.data.confirmationToken },
        ctx
      );
      assert.equal(drift.data.ok, false);
      assert.equal(drift.data.reason, 'RECIPIENT_COUNT_MISMATCH');

      // The cap: an audience over the stated ceiling never earns a token at all.
      const capped = await execute(getDefinition('broadcast_notification'), { ...args, maxRecipients: 2 }, ctx);
      assert.equal(capped.data.ok, false);
      assert.equal(capped.data.reason, 'TOO_MANY_RECIPIENTS');
      assert.equal(capped.data.confirmationToken, undefined);
    } finally {
      notificationService.resolveAudience = original;
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

