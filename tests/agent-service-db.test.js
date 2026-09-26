'use strict';

/**
 * Phase 3 — the orchestrator, end to end against the real database.
 *
 * The three claims worth an integration test:
 *   1. A catalogued question never builds a graph (no model, no cost).
 *   2. A model answer that quotes a figure no tool returned is refused, not shown.
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

  assert.equal(result.ok, true, `expected a grounded answer, got ${result.code || ''} ${result.ungrounded || ''}`);
  assert.equal(result.source, 'llm');
  assert.equal(result.detail.provider, 'scripted');
  assert.deepEqual(result.detail.toolCalls, ['platform_overview']);

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

test('a fabricated statistic is refused, and nothing is persisted', async () => {
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

  assert.equal(result.ok, false);
  assert.equal(result.code, 'GROUNDING_FAILED');
  assert.deepEqual(result.ungrounded, ['999,999']);
  // Phase 4.5: a refused FIRST turn has no conversation to count messages in, because
  // nothing is created at all any more (the sibling test below pins the row count).
  // Prisma also refuses a null filter, so the id itself is the assertion: it proves no
  // transcript was ever opened. A refused FOLLOW-UP turn still has a conversation,
  // and that path is covered by the successful-turn history assertion below.
  assert.equal(result.conversationId, null, 'a rejected first answer must not open a conversation');
});

test('a refused turn leaves NO conversation row behind (the sidebar-orphan defect)', async () => {
  // Phase 4.5. Before this, the conversation row was created BEFORE the turn was
  // answered, so every failed turn left a titless, message-less conversation in the
  // admin's sidebar — 25 of 70 rows in one diagnostic session. A conversation is now
  // written together with the turn that gives it meaning, so a turn with nothing to
  // store must leave nothing at all.
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
  assert.equal(result.ok, false);

  const after = await prisma.agentConversation.count({ where: { adminId: ADMIN_ID } });
  assert.equal(after, before, 'a refused turn must not create a conversation');
  assert.equal(result.conversationId, null, 'and it must not hand out an id for one');
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


