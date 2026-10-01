'use strict';

/**
 * Phase 2 — the deterministic fast path END TO END against the real database.
 *
 * These assertions are about the guarantees that only exist once real code paths
 * run: that the engine answers with data it did not compute, that it declines
 * instead of guessing, that it refuses to write anything, and that every guard
 * (kill switch, read-only check, arg validation, tool failure) produces its own
 * explicit decision rather than a plausible-looking answer.
 */

process.env.REDIS_ENABLED = 'false';
// Keep this suite's connection footprint small: it runs next to the heavyweight
// suites against one shared database.
process.env.DATABASE_CONNECTION_LIMIT = '5';
process.env.AI_AGENT_ENABLED = 'true'; // required before src/config/env.js loads

const test = require('node:test');
const assert = require('node:assert/strict');

const prisma = require('../src/config/db');
const config = require('../src/config/env');
const { answerDeterministic, isEnabled, validateCatalogue } = require('../src/services/agent/engine');
const { INTENTS } = require('../src/services/agent/router');
const { actionDefinitions } = require('../src/services/agent/tools');

const ADMIN_ID = 1;
const ctx = { prisma, adminId: ADMIN_ID };

const realQuestion = INTENTS.find((i) => i.id === 'courses_list').samples[0];

test('the kill switch is honoured: no answers while the agent is disabled', async () => {
  const original = config.aiAgent.enabled;
  assert.equal(original, true, 'this suite requires AI_AGENT_ENABLED=true');
  try {
    config.aiAgent.enabled = false;
    assert.equal(isEnabled(), false);
    const declined = await answerDeterministic(realQuestion, ctx);
    assert.equal(declined.matched, false);
    assert.equal(declined.reason, 'AGENT_DISABLED');
  } finally {
    config.aiAgent.enabled = original;
  }
  assert.equal(isEnabled(), true);
});

test('an analytics question is answered from a real tool result', async () => {
  const answer = await answerDeterministic(realQuestion, ctx);

  assert.equal(answer.matched, true, `expected a match, got ${answer.reason}`);
  assert.equal(answer.source, 'deterministic');
  assert.equal(answer.intent, 'courses_list');
  assert.equal(answer.tool, 'courses_list');
  assert.ok(answer.answer.startsWith('### '), 'answer must be Arabic Markdown');
  assert.ok(answer.answer.includes('🕒'), 'answer must state its window/snapshot');
  assert.doesNotMatch(answer.answer, /undefined|NaN/);

  // The payload is the tool's, unchanged: the engine formats, it never computes.
  assert.ok(Array.isArray(answer.result.rows));
  assert.equal(answer.meta.tool, 'courses_list');
  assert.ok(!Number.isNaN(Date.parse(answer.meta.asOf)));
  assert.ok(answer.latencyMs >= 0);
});

test('the engine declines questions it cannot answer deterministically', async () => {
  const unknown = await answerDeterministic('اعمل تقرير مفصل عن كل حاجة في المنصة', ctx);
  assert.equal(unknown.matched, false);
  assert.equal(unknown.reason, 'NO_INTENT');

  const ambiguous = await answerDeterministic('احدث النشاط الاداري', ctx);
  assert.equal(ambiguous.reason, 'AMBIGUOUS');

  const missingSlug = await answerDeterministic('ملف الطالب', ctx);
  assert.equal(missingSlug.reason, 'MISSING_SLOT_SLUG');

  // A decline carries no answer field, so a caller cannot accidentally render one.
  for (const declined of [unknown, ambiguous, missingSlug]) {
    assert.equal(declined.answer, undefined);
  }
});

test('every catalogued question answers with Arabic content and no raw payload leakage', async () => {
  // A single representative question per intent — the full 80+ sample replay runs
  // in the pure router suite, which needs no database.
  const checked = [];
  for (const intent of INTENTS) {
    // Profile/detail intents need a real slug; use the catalogue's own sample so
    // the routing path is the shipped one.
    const question = intent.samples[0];
    const answer = await answerDeterministic(question, ctx);
    assert.equal(answer.matched, true, `"${question}" -> ${answer.reason}`);
    assert.equal(answer.intent, intent.id);
    assert.ok(answer.answer.length > 40, `"${question}" produced a stub answer`);
    assert.doesNotMatch(answer.answer, /undefined|NaN|\[object/);
    checked.push(intent.id);
  }
  assert.equal(checked.length, INTENTS.length);
});

/** Read-only Prisma operations the analytics tools are allowed to use. */
const READ_METHODS = new Set(['findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy']);

/**
 * Wrap the real client and record ANY operation that is not a known read.
 *
 * Counting rows around the call is not good enough: test files run in parallel
 * against one shared database, so another suite's writes would make a global
 * count differ and the assertion would flake. Watching the CALLS is both
 * parallel-safe and a stronger claim — it also proves the Prisma-only doctrine,
 * because raw SQL would be recorded as a violation too.
 */
function createWriteSpy(real) {
  const violations = [];
  const wrapModel = (model, modelName) =>
    new Proxy(model, {
      get(target, method) {
        const fn = target[method];
        if (typeof fn !== 'function') return fn;
        return function wrapped(...args) {
          if (!READ_METHODS.has(String(method))) violations.push(`${modelName}.${String(method)}`);
          return fn.apply(target, args);
        };
      },
    });

  const spy = new Proxy(real, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value === 'function') {
        return function wrapped(...args) {
          // $disconnect/$connect/$transaction etc. are never expected here.
          violations.push(`$${String(prop).replace(/^\$/, '')}`);
          return value.apply(target, args);
        };
      }
      if (value && typeof value === 'object') return wrapModel(value, String(prop));
      return value;
    },
  });

  return { spy, violations };
}

test('the fast path issues zero write operations (structurally read-only)', async () => {
  const { spy, violations } = createWriteSpy(prisma);

  const questions = [
    'نظرة عامة على المنصة',
    'إحصائيات الاشتراكات',
    'ملخص الإيرادات',
    'أصعب الاختبارات',
    'قائمة الاختبارات',
    'حالة معالجة الفيديوهات',
  ];
  for (const question of questions) {
    const answer = await answerDeterministic(question, { prisma: spy, adminId: ADMIN_ID });
    // A tool error would also explain "no writes", so require real answers.
    assert.equal(answer.matched, true, `"${question}" -> ${answer.reason}`);
    assert.ok(answer.result, `"${question}" returned no payload`);
  }

  assert.deepEqual(violations, [], `the deterministic tier must never write; saw: ${violations.join(', ')}`);
});


test('the engine refuses a catalogue entry that points at a mutating tool', () => {
  const actionName = actionDefinitions[0].name;
  const fakeActionIntent = {
    id: 'fake_action_intent',
    tool: actionName,
    template: 'courses_by_grade',
    samples: ['x'],
    phrases: ['x'],
    args: () => ({}),
  };
  INTENTS.push(fakeActionIntent);
  try {
    assert.throws(() => validateCatalogue(), /non-read tool/);
  } finally {
    INTENTS.pop();
  }

  const fakeTemplateIntent = { ...fakeActionIntent, id: 'fake_template_intent', tool: 'courses_by_grade', template: 'no_such_template' };
  INTENTS.push(fakeTemplateIntent);
  try {
    assert.throws(() => validateCatalogue(), /unknown template/);
  } finally {
    INTENTS.pop();
  }

  // Back to a valid catalogue: the guard must not have left state behind.
  assert.doesNotThrow(() => validateCatalogue());
});

test('router/tool drift surfaces as an explicit mismatch, never a wrong answer', async () => {
  // Read tools accept any non-empty slug on purpose (a miss answers "not found"),
  // so this guard is exercised with an ENUM argument, which must reject.
  const intent = INTENTS.find((i) => i.id === 'quiz_attempts');
  const originalArgs = intent.args;
  intent.args = () => ({ status: 'NOT_A_REAL_STATUS' });
  try {
    const result = await answerDeterministic(intent.samples[0], ctx);
    assert.equal(result.matched, false);
    assert.equal(result.reason, 'ROUTER_ARG_MISMATCH');
    assert.deepEqual(result.candidates, ['quiz_attempts']);
    assert.match(result.detail, /status/);
  } finally {
    intent.args = originalArgs;
  }

  // The shipped catalogue still works.
  const ok = await answerDeterministic(intent.samples[0], ctx);
  assert.equal(ok.matched, true);
});

test('a failing tool is reported as a failure, not as an empty answer', async () => {
  const brokenPrisma = {}; // every model access throws a TypeError
  const result = await answerDeterministic('نظرة عامة على المنصة', { prisma: brokenPrisma, adminId: ADMIN_ID });

  assert.equal(result.matched, false);
  assert.equal(result.reason, 'TOOL_ERROR');
  assert.ok(result.error && result.error.message, 'the failure must carry a message to log');
  assert.equal(result.answer, undefined);
});

test('fast-path answers inherit the tool layer row cap', async () => {
  const cap = config.aiAgent.maxToolResultRows;
  const forCappedTool = INTENTS.find((i) => i.tool === 'courses_list');
  const result = await answerDeterministic(forCappedTool.samples[0], ctx);

  assert.equal(result.matched, true);
  assert.ok(result.result.rows.length <= cap, `rows (${result.result.rows.length}) exceeded the cap (${cap})`);
  assert.equal(result.meta.cappedAt, cap);
});

test('after', async () => {
  // The suite owns its pool; leave nothing hanging for the runner.
  await prisma.$disconnect();
});

