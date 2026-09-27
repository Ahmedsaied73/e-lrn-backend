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
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { actionDefinitions, getDefinition } = require('../src/services/agent/tools');
const { execute, AgentToolError } = require('../src/services/agent/tools/_kit');
const { disconnectRedis } = require('../src/integrations/redis/redisClient');

const ARABIC_RE = /[\u0600-\u06FF]/;
const ADMIN_ID = 42;

// 12-char lowercase base36, the only identifier shape the platform issues.
const STUDENT_SLUG = 'stu123abc456';
const COURSE_SLUG = 'crs123abc456';

const CRUD_TOOLS = [
  { name: 'create_student', audit: 'USER_CREATE', target: 'user' },
  { name: 'update_student', audit: 'USER_UPDATE', target: 'user' },
  { name: 'create_course', audit: 'COURSE_CREATE', target: 'course' },
  { name: 'update_course', audit: 'COURSE_UPDATE', target: 'course' },
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

describe('agent CRUD tools (P2a) — catalogue contract', () => {
  it('adds exactly the four approved students/courses tools', () => {
    const names = actionDefinitions.map((d) => d.name);
    for (const { name } of CRUD_TOOLS) {
      assert.ok(names.includes(name), `${name} is missing from the action catalogue`);
    }
    // The delete tools are a LATER phase by product decision — shipping one here
    // would put an irreversible write in front of the model before that review.
    for (const forbidden of ['delete_user', 'delete_course', 'delete_video', 'delete_quiz']) {
      assert.equal(names.includes(forbidden), false, `${forbidden} must not exist yet`);
    }
  });

  it('every new tool is an approval-gated, uncached, Arabic, audited action', () => {
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

