'use strict';

/**
 * Phase 4 — the orchestrator, end to end against the real database.
 *
 * The three claims worth an integration test:
 *   1. A catalogued question never builds a graph (no model, no cost).
 *   2. A model answer whose figures no tool returned is SHOWN with a caveat, and
 *      the figures are recorded on the turn (handoff 3.4 — the old refusal is gone).
 *   3. An action runs only under an approval bound to ITS OWN tool and arguments —
 *      and that approval is then spent, so it cannot be replayed.
 */

process.env.REDIS_ENABLED = 'false';
process.env.DATABASE_CONNECTION_LIMIT = '5';
process.env.AI_AGENT_ENABLED = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AIMessage } = require('@langchain/core/messages');
const config = require('../src/config/env');
const prisma = require('../src/config/db');
const { answerQuestion } = require('../src/services/agent/agentService');
const { execute } = require('../src/services/agent/tools/_kit');
const { getDefinition } = require('../src/services/agent/tools');
const { requestApproval, decideApproval, getApproval } = require('../src/services/agent/approvals');
const { createAgentGraph } = require('../src/services/agent/graph');

const ADMIN_ID = 1;
const createdConversations = [];
const createdApprovals = [];

function scriptedGraphFactory(script) {
  const calls = [];
  return {
    calls,
    factory: (options) =>
      createAgentGraph({
        ...options,
        invokeModel: async (messages) => {
          calls.push(messages.length);
          const next = script.shift();
          if (!next) throw new Error('scripted model ran out of responses');
          return { result: next, provider: 'scripted' };
        },
      }),
  };
}

function toolCall(name, args, id) {
  return new AIMessage({ content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] });
}

async function trackConversation(conversationId) {
  if (conversationId && !createdConversations.includes(conversationId)) createdConversations.push(conversationId);
}

async function waitFor(fn, { tries = 6, delayMs = 150 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

test('a catalogued question is answered without ever building a graph', async () => {
  let graphBuilt = false;
  const result = await answerQuestion({
    question: 'كم طالب في المنصة؟',
    adminId: ADMIN_ID,
    prisma,
    graphFactory: () => {
      graphBuilt = true;
      throw new Error('the deterministic tier must not build a graph');
    },
  });

  await trackConversation(result.conversationId);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'deterministic');
  assert.equal(result.detail.intent, 'students_by_grade');
  assert.equal(graphBuilt, false, 'no model work may happen for a catalogued question');

  // The turn was persisted as a question + answer pair.
  const messages = await prisma.agentMessage.findMany({
    where: { conversationId: result.conversationId },
    orderBy: { id: 'asc' },
    select: { role: true, metadata: true },
  });
  assert.deepEqual(
    messages.map((m) => m.role),
    ['USER', 'ASSISTANT']
  );
  // conversationService whitelists turn metadata, so this asserts the whitelisted
  // fact rather than an arbitrary key the store would have dropped.
  assert.equal(messages[1].metadata.deterministic, true);
  assert.deepEqual(messages[1].metadata.toolCalls, ['students_count_by_grade']);
});

test('the kill switch stops the service before anything else happens', async () => {
  const original = config.aiAgent.enabled;
  config.aiAgent.enabled = false;
  try {
    const result = await answerQuestion({ question: 'كم طالب في المنصة؟', adminId: ADMIN_ID, prisma });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'AGENT_DISABLED');
    assert.equal(result.conversationId, undefined, 'nothing may be written while disabled');
  } finally {
    config.aiAgent.enabled = original;
  }
});

test('an empty question is refused, and an unconfigured provider is stated plainly', async () => {
  const empty = await answerQuestion({ question: '   ', adminId: ADMIN_ID, prisma });
  assert.equal(empty.code, 'EMPTY_QUESTION');

  const agentConfig = config.aiAgent;
  const snapshot = { configured: agentConfig.configured, primary: agentConfig.primary };
  agentConfig.configured = false;
  agentConfig.primary = null;
  try {
    const result = await answerQuestion({
      question: 'اعمل تقرير مفصل عن كل حاجة في المنصة',
      adminId: ADMIN_ID,
      prisma,
    });
    await trackConversation(result.conversationId);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'LLM_NOT_CONFIGURED');
    assert.equal(result.declinedReason, 'NO_INTENT');
  } finally {
    agentConfig.configured = snapshot.configured;
    agentConfig.primary = snapshot.primary;
  }
});

test('a model answer is accepted only when its figures trace to tool output', async () => {
  // Learn a real figure the same way the model would: by asking a tool.
  const probe = await execute(getDefinition('platform_overview'), {}, { prisma, adminId: ADMIN_ID });
  const students = probe.data.users.students;
  assert.ok(Number.isFinite(students));

  const grounded = scriptedGraphFactory([
    toolCall('platform_overview', {}, 'call_overview'),
    new AIMessage({ content: `يوجد ${students} طالباً مسجّلاً على المنصة.` }),
  ]);
  const result = await answerQuestion({
    question: 'اعمل تقرير مفصل عن كل حاجة في المنصة',
    adminId: ADMIN_ID,
    prisma,
    graphFactory: grounded.factory,
  });
  await trackConversation(result.conversationId);

  assert.equal(result.ok, true, `expected a grounded answer, got ${result.code || ''}`);
  assert.equal(result.source, 'llm');
  assert.equal(result.detail.provider, 'scripted');
  assert.deepEqual(result.detail.toolCalls, ['platform_overview']);
  assert.deepEqual(result.detail.unverifiedFigures, [], 'a clean turn records an empty findings list');
  assert.ok(!result.answer.includes('مش متأكد إنه من بيانات المنصة'), 'and appends no caveat');

  // The model-answered turn is persisted and audited (the deterministic tier is
  // reproducible from the catalogue; a model turn is not).
  const messages = await prisma.agentMessage.count({ where: { conversationId: result.conversationId } });
  assert.equal(messages, 2);
  const auditRow = await waitFor(() =>
    prisma.auditLog.findFirst({
      where: { action: 'AGENT_TURN', targetType: 'AgentConversation', targetId: result.conversationId },
      select: { id: true, actorId: true },
    })
  );
  assert.ok(auditRow, 'a model-answered turn must leave an audit row');
  assert.equal(auditRow.actorId, ADMIN_ID);
});

test('a fabricated statistic is shown WITH a caveat, and the figures are recorded', async () => {
  // Phase 4 (handoff 3.4, Decision #13): the old `GROUNDING_FAILED` refusal is gone.
  // The answer the model wrote is the answer the admin sees — intact, with one honest
  // caveat — and the turn carries the figures the guard could not trace.
  const fabricated = scriptedGraphFactory([
    toolCall('platform_overview', {}, 'call_overview'),
    new AIMessage({ content: 'عدد الطلاب 999,999 طالباً.' }),
  ]);
  const result = await answerQuestion({
    question: 'اعمل تقرير مفصل عن كل حاجة في المنصة',
    adminId: ADMIN_ID,
    prisma,
    graphFactory: fabricated.factory,
  });
  await trackConversation(result.conversationId);

  assert.equal(result.ok, true, 'a flagged answer is shown, never discarded');
  assert.match(result.answer, /^عدد الطلاب 999,999 طالباً\./, 'the model text itself is untouched');
  assert.deepEqual(result.detail.unverifiedFigures, ['999,999']);
  assert.match(result.answer, /\(الرقم ده مش متأكد إنه من بيانات المنصة، اتأكد منه لو مهم\)/);

  // Phase 4.5's guarantee survives the inversion: a shown turn is a stored turn, so
  // the conversation holds its question + answer pair — and the flag is queryable.
  const messages = await prisma.agentMessage.findMany({
    where: { conversationId: result.conversationId },
    orderBy: { id: 'asc' },
    select: { role: true, content: true, metadata: true },
  });
  assert.deepEqual(messages.map((m) => m.role), ['USER', 'ASSISTANT']);
  assert.match(messages[1].content, /999,999/);
  assert.match(messages[1].content, /مش متأكد إنه من بيانات المنصة/);
  assert.deepEqual(messages[1].metadata.unverifiedFigures, ['999,999']);
});

test('a flagged turn leaves a conversation WITH its answer (nothing is dropped)', async () => {
  // Phase 4.5's orphan rule, re-pinned for the advisory world: with no discard
  // path left, every turn has something to store, so every turn stores it.
  const before = await prisma.agentConversation.count({ where: { adminId: ADMIN_ID } });

  const fabricated = scriptedGraphFactory([
    toolCall('platform_overview', {}, 'call_overview'),
    new AIMessage({ content: 'عدد الطلاب 888,888 طالباً.' }),
  ]);
  const result = await answerQuestion({
    question: 'اعمل تقرير مفصل عن كل شيء في المنصة',
    adminId: ADMIN_ID,
    prisma,
    graphFactory: fabricated.factory,
  });
  assert.equal(result.ok, true, 'there is no refusal path left to trigger');

  const after = await prisma.agentConversation.count({ where: { adminId: ADMIN_ID } });
  assert.equal(after, before + 1, 'a shown turn must create its conversation');
  assert.ok(result.conversationId, 'and it must hand out an id for it');
  assert.deepEqual(result.detail.unverifiedFigures, ['888,888']);
});

/**
 * §3.5 / Decision #17 — the provider-outage contract, end to end.
 *
 * The provider layer is pinned to "two attempts, then ONE typed failure" in
 * tests/agent-llm-provider.test.js; what is pinned HERE is the turn handler: the fast
 * path gets one last deterministic look before giving up, and the admin is told
 * plainly that the model tier is down — no silent retry behind the answer.
 *
 * `answerFactory` is the seam that makes "the fast path was consulted again" an
 * assertion instead of a hope: the router is called for tier 1 and, on an outage, once
 * more. Counting those calls is the only way to prove the second look happened.
 */
test('a provider outage consults the fast path once more, then fails as PROVIDER_UNAVAILABLE', async () => {
  const outage = new Error('every configured model failed transiently');
  outage.code = 'ALL_PROVIDERS_FAILED';
  const calls = [];
  const declining = async () => {
    calls.push('route');
    return { matched: false, reason: 'NO_INTENT' };
  };

  const result = await answerQuestion({
    question: 'اعمل تقرير مفصل عن كل حاجة في المنصة',
    adminId: ADMIN_ID,
    prisma,
    answerFactory: declining,
    // The factory is CALLED before the try block, so the failure has to come from
    // invoking the graph — exactly where a real provider outage surfaces.
    graphFactory: () => ({
      graph: {
        invoke: async () => {
          throw outage;
        },
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_UNAVAILABLE', 'the outage is named, not hidden behind a generic error');
  assert.match(result.message, /مش مستجيب/, 'the admin is told plainly, in dialect');
  assert.equal(calls.length, 2, 'tier 1 declined, and the outage path asked the fast path exactly once more');
});

test('an outage that the fast path CAN now answer is answered, not reported as an outage', async () => {
  // A deterministic route() is a pure function of the question, so in production this
  // second look cannot succeed where the first declined — the fixture stubs an
  // impossible-in-production second answer on purpose, to prove the branch is wired
  // rather than merely reachable. This is a WIRING pin, not a behaviour claim.
  const outage = new Error('every configured model failed transiently');
  outage.code = 'ALL_PROVIDERS_FAILED';
  let call = 0;
  const answering = async () => {
    call += 1;
    if (call === 1) return { matched: false, reason: 'NO_INTENT' };
    return { matched: true, intent: 'students_by_grade', answer: 'عدد الطلاب ١٢٣', latencyMs: 3, tool: 'students_count_by_grade' };
  };

  const result = await answerQuestion({
    question: 'اعمل تقرير مفصل عن كل حاجة في المنصة',
    adminId: ADMIN_ID,
    prisma,
    answerFactory: answering,
    graphFactory: () => ({
      graph: {
        invoke: async () => {
          throw outage;
        },
      },
    }),
  });
  await trackConversation(result.conversationId);

  assert.equal(result.ok, true);
  assert.equal(result.source, 'deterministic');
  assert.equal(result.answer, 'عدد الطلاب ١٢٣');
  assert.equal(call, 2, 'the last chance was the fast path, and it was used');
});

test('a NON-outage model failure is NOT reported as an outage, and the fast path is not re-consulted', async () => {
  // A bad key or a malformed request is a different fact from "the service is down":
  // reporting it as an outage would send the admin to retry something that can never
  // succeed, and the last-chance fast path cannot fix a request error.
  const badKey = new Error('invalid api key');
  badKey.status = 401;
  const calls = [];
  const result = await answerQuestion({
    question: 'اعمل تقرير مفصل عن كل حاجة في المنصة',
    adminId: ADMIN_ID,
    prisma,
    answerFactory: async () => {
      calls.push('route');
      return { matched: false, reason: 'NO_INTENT' };
    },
    graphFactory: () => ({
      graph: {
        invoke: async () => {
          throw badKey;
        },
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'LLM_ERROR');
  assert.equal(calls.length, 1, 'only the tier-1 fast path ran');
});

test('a new conversation is created WITH its first turn, titled from that question', async () => {
  const scripted = scriptedGraphFactory([
    toolCall('platform_overview', {}, 'call_overview'),
    new AIMessage({ content: 'المنصة تعمل بشكل طبيعي.' }),
  ]);
  const result = await answerQuestion({
    question: 'ملخص حالة المنصة الآن',
    adminId: ADMIN_ID,
    prisma,
    graphFactory: scripted.factory,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(Number.isSafeInteger(result.conversationId), 'a successful turn must return its id');
  await trackConversation(result.conversationId);

  const row = await prisma.agentConversation.findUnique({
    where: { id: result.conversationId },
    select: { title: true, adminId: true, _count: { select: { messages: true } } },
  });
  assert.equal(row.adminId, ADMIN_ID);
  assert.equal(row.title, 'ملخص حالة المنصة الآن', 'the title comes from the first question');
  assert.equal(row._count.messages, 2, 'the row is born with its question and its answer');

  // Read-after-write: the turn must be visible the moment the caller is told about it.
  const history = await prisma.agentMessage.findMany({
    where: { conversationId: result.conversationId },
    orderBy: { createdAt: 'asc' },
    select: { role: true },
  });
  assert.deepEqual(history.map((m) => m.role), ['USER', 'ASSISTANT']);
});

test('an action runs only under an approval bound to its exact arguments', async () => {
  const originalAllow = config.aiAgent.allowMutations;
  config.aiAgent.allowMutations = true;
  try {
    const args = { userSlug: 'aaaaaaaaaaaa', courseSlug: 'bbbbbbbbbbbb' };
    const approval = await requestApproval({
      prisma,
      adminId: ADMIN_ID,
      toolName: 'mark_enrollment_paid',
      args,
      ttlMs: 60_000,
    });
    createdApprovals.push(approval.id);
    await decideApproval({ prisma, approvalId: approval.id, adminId: ADMIN_ID, approved: true });

    const scripted = scriptedGraphFactory([
      toolCall('mark_enrollment_paid', args, 'action_1'),
      new AIMessage({ content: 'لا يوجد اشتراك بهذا المعرّف.' }),
    ]);
    const result = await answerQuestion({
      question: 'علّم اشتراك الطالب كمدفوع',
      adminId: ADMIN_ID,
      prisma,
      approvalId: approval.id,
      graphFactory: scripted.factory,
    });
    await trackConversation(result.conversationId);

    assert.equal(result.ok, true, `expected the turn to complete, got ${result.code || ''}`);
    assert.equal(result.source, 'llm');
    assert.equal(result.detail.approval, approval.id, 'the used approval must be reported');

    const consumed = await prisma.agentApproval.findUnique({ where: { id: approval.id }, select: { status: true } });
    assert.equal(consumed.status, 'CONSUMED', 'spending the approval must be recorded');
  } finally {
    config.aiAgent.allowMutations = originalAllow;
  }
});

test('an approval for one argument set cannot authorise a different call', async () => {
  const originalAllow = config.aiAgent.allowMutations;
  config.aiAgent.allowMutations = true;
  try {
    const approvedArgs = { userSlug: 'aaaaaaaaaaaa', courseSlug: 'bbbbbbbbbbbb' };
    const approval = await requestApproval({
      prisma,
      adminId: ADMIN_ID,
      toolName: 'mark_enrollment_paid',
      args: approvedArgs,
      ttlMs: 60_000,
    });
    createdApprovals.push(approval.id);
    await decideApproval({ prisma, approvalId: approval.id, adminId: ADMIN_ID, approved: true });

    // The model asks for a DIFFERENT course than the one that was approved.
    const scripted = scriptedGraphFactory([
      toolCall('mark_enrollment_paid', { userSlug: 'aaaaaaaaaaaa', courseSlug: 'cccccccccccc' }, 'action_2'),
      new AIMessage({ content: 'تم إرسال الطلب للمراجعة.' }),
    ]);
    const result = await answerQuestion({
      question: 'علّم اشتراك الطالب كمدفوع',
      adminId: ADMIN_ID,
      prisma,
      approvalId: approval.id,
      graphFactory: scripted.factory,
    });
    await trackConversation(result.conversationId);

    const untouched = await getApproval({ prisma, approvalId: approval.id, adminId: ADMIN_ID });
    assert.equal(untouched.status, 'APPROVED', 'a mismatched call must not spend the approval');
    assert.equal(result.detail ? result.detail.approval : null, null, 'no approval may be reported as used');
  } finally {
    config.aiAgent.allowMutations = originalAllow;
  }
});

test('cleanup', async () => {
  await prisma.agentConversation.deleteMany({ where: { id: { in: createdConversations } } });
  await prisma.agentApproval.deleteMany({ where: { id: { in: createdApprovals } } });
  const leftovers = await prisma.agentConversation.count({ where: { id: { in: createdConversations } } });
  const approvals = await prisma.agentApproval.count({ where: { id: { in: createdApprovals } } });
  assert.equal(leftovers, 0);
  assert.equal(approvals, 0);
  await prisma.$disconnect();
});


