'use strict';
/* Agent tool contract tests (Phase 1) — pure: no DB, no Redis, no network.
 *
 * These pin the properties that make the tool layer safe to hand to a model:
 *   1. The registry loads and self-validates (unique snake_case names, Arabic
 *      descriptions, Zod schemas, every action carrying an audit action).
 *   2. Read-only is the default: action tools exist but are NOT exposed to the
 *      model unless AI_AGENT_ALLOW_MUTATIONS is on.
 *   3. execute() validates arguments before doing anything else.
 *   4. execute() REFUSES any action without explicit, attributable approval —
 *      the guard behind the graph interrupt.
 *   5. Every payload leaving a tool is email-redacted and carries meta.
 *   6. The LangChain wrapper keeps the approval gate (it is not a bypass).
 *
 * Run: npm test
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  readDefinitions,
  actionDefinitions,
  listDefinitions,
  getDefinition,
  toLangChainTools,
} = require('../src/services/agent/tools');
const { execute, readTool, AgentToolError } = require('../src/services/agent/tools/_kit');
const { disconnectRedis } = require('../src/integrations/redis/redisClient');

// Safety net: if any tool under test touches the cache, close the handle so the
// runner exits instead of hanging on an unreachable Redis socket.
after(async () => {
  await disconnectRedis();
});

const ARABIC_RE = /[\u0600-\u06FF]/;

/** Minimal Prisma stand-in: counts return 7, groupBy returns one status row. */
function prismaStub() {
  const count = async () => 7;
  const groupBy = async () => [{ status: 'GRADED', _count: { _all: 5 } }];
  return {
    user: { count },
    course: { count },
    enrollment: { count },
    quiz: { count },
    quizAttempt: { count, groupBy },
    bunnyVideo: { count, groupBy },
    certificate: { count },
    aiGradingJob: { count },
    submission: { count },
  };
}

describe('agent tools — registry contract', () => {
  it('exposes the full read catalogue and (loaded but unexposed) actions', () => {
    assert.ok(readDefinitions.length >= 25, `expected >= 25 read tools, got ${readDefinitions.length}`);
    assert.equal(actionDefinitions.length, 12, 'the approved mutation catalogue is 12 tools');
    // Default posture: read-only. A mutation switch that is off must not leak
    // mutating tools into the model's tool list.
    assert.equal(listDefinitions().length, readDefinitions.length, 'actions hidden by default');
    assert.equal(listDefinitions().some((d) => d.kind === 'action'), false, 'no action in the default list');
    assert.equal(listDefinitions({ includeActions: true }).length, readDefinitions.length + 12, 'all when armed');
  });

  it('names are unique snake_case and every description is Arabic', () => {
    const names = new Set();
    for (const def of [...readDefinitions, ...actionDefinitions]) {
      assert.match(def.name, /^[a-z][a-z0-9_]{2,63}$/, `${def.name} must be snake_case`);
      assert.equal(names.has(def.name), false, `${def.name} duplicated`);
      names.add(def.name);
      assert.ok(ARABIC_RE.test(def.description), `${def.name} description must be Arabic`);
      assert.ok(def.description.length >= 20, `${def.name} description must be explanatory`);
      assert.equal(typeof def.schema.safeParse, 'function', `${def.name} needs a Zod schema`);
    }
  });

  it('every action declares approval + an audit action and is never cached', () => {
    for (const def of actionDefinitions) {
      assert.equal(def.kind, 'action', `${def.name} kind`);
      assert.equal(def.requiresApproval, true, `${def.name} requiresApproval`);
      assert.equal(def.cacheTtlSeconds, 0, `${def.name} must not be cached`);
      assert.match(def.audit.action, /^[A-Z][A-Z0-9_]+$/, `${def.name} audit action shape`);
    }
  });

  it('the approved mutation catalogue is exactly the approved list', () => {
    const names = actionDefinitions.map((d) => d.name).sort();
    assert.deepEqual(names, [
      'broadcast_notification',
      'enroll_student',
      'grade_essay',
      'grant_gate_exemption',
      'mark_enrollment_paid',
      'mark_video_failed',
      'reorder_course_videos',
      'reset_quiz_attempt',
      'retry_ai_grading',
      'revoke_gate_exemption',
      'unenroll_student',
      'update_course_price',
    ]);
  });
});

describe('agent tools — execute() guards', () => {
  it('rejects invalid arguments before touching anything', async () => {
    const gradeEssay = getDefinition('grade_essay');
    await assert.rejects(
      () => execute(gradeEssay, {}, { prisma: prismaStub(), approved: true, adminId: 1 }),
      (err) => err instanceof AgentToolError && err.code === 'INVALID_ARGS'
    );
  });

  it('refuses an action with no approval, and one that cannot be attributed', async () => {
    const enroll = getDefinition('enroll_student');
    // Well-formed slugs on purpose: the schema must accept them so the APPROVAL
    // gate — not argument validation — is what refuses the call.
    const args = { userSlug: 'abc123abc123', courseSlug: 'def456def456' };

    await assert.rejects(
      () => execute(enroll, args, { prisma: prismaStub() }),
      (err) => err.code === 'APPROVAL_REQUIRED',
      'unapproved action must refuse'
    );
    await assert.rejects(
      () => execute(enroll, args, { prisma: prismaStub(), approved: true }),
      (err) => err.code === 'APPROVAL_REQUIRED',
      'approval without an admin id must refuse'
    );
    await assert.rejects(
      () => execute(enroll, args, { prisma: prismaStub(), approved: true, adminId: '1' }),
      (err) => err.code === 'APPROVAL_REQUIRED',
      'a string admin id is not attributable'
    );
  });

  it('redacts emails and attaches meta to a read payload', async () => {
    const probe = readTool({
      name: '_redaction_probe',
      description: 'أداة داخلية للتحقق من حجب البريد الإلكتروني في مخرجات الأدوات',
      cacheTtlSeconds: 0,
      run: async () => ({
        rows: [{ name: 'أحمد', phoneNumber: '01001234567', email: 'ahmed@example.com' }],
        returned: 1,
        truncated: false,
      }),
    });

    const result = await execute(probe, {}, { prisma: prismaStub() });
    assert.equal(result.data.rows[0].email, 'a***@example.com', 'email masked on the way out');
    assert.equal(result.data.rows[0].name, 'أحمد', 'name allowed');
    assert.equal(result.data.rows[0].phoneNumber, '01001234567', 'phone allowed');
    assert.equal(result.meta.tool, '_redaction_probe');
    assert.equal(result.meta.cappedAt, 50, 'read tools advertise the active row cap');
    assert.ok(!Number.isNaN(Date.parse(result.meta.asOf)), 'asOf is a timestamp');
  });

  it('runs a real read tool end to end against a stub pool (no DB)', async () => {
    const overview = getDefinition('platform_overview');
    // Cache disabled for this unit check (a live Redis handle would outlive the
    // process); the caching INTENT is asserted separately below.
    assert.ok(overview.cacheTtlSeconds > 0, 'platform_overview is cached by design');
    const result = await execute({ ...overview, cacheTtlSeconds: 0 }, {}, { prisma: prismaStub() });
    assert.equal(result.data.users.students, 7, 'student count passes through');
    assert.equal(result.data.enrollments.unpaid, 0, 'paid/unpaid derived correctly');
    assert.equal(result.data.videos.byStatus.GRADED, 5, 'groupBy map built');
    assert.equal(result.meta.cappedAt, 50, 'cap advertised even for aggregates');
  });

  it('rejects an argument the tool does not declare (no silently ignored filters)', async () => {
    const overview = getDefinition('platform_overview');
    await assert.rejects(
      () => execute({ ...overview, cacheTtlSeconds: 0 }, { windowDays: 5 }, { prisma: prismaStub() }),
      (err) => err instanceof AgentToolError && err.code === 'INVALID_ARGS',
      'an undeclared argument must fail loudly instead of being stripped'
    );
  });
});
describe('agent tools — LangChain wrapper', () => {
  it('wraps every default tool with its own name', () => {
    const tools = toLangChainTools();
    assert.equal(tools.length, readDefinitions.length, 'wrapper honours the default posture');
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...readDefinitions.map((d) => d.name)].sort());
  });

  it('cannot be used to bypass the approval gate', async () => {
    const [enrollTool] = toLangChainTools([getDefinition('enroll_student')]);
    await assert.rejects(
      () => enrollTool.invoke({ userSlug: 'abc123abc123', courseSlug: 'def456def456' }),
      (err) => /APPROVAL_REQUIRED|requires human approval/.test(String(err.message)),
      'the wrapper must not swallow the approval refusal'
    );
  });

  it('returns null for an unknown tool name instead of throwing', () => {
    assert.equal(getDefinition('does_not_exist'), null);
  });
});
