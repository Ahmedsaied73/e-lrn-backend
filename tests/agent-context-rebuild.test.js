'use strict';

/**
 * Phase 9A — Rebuilding the model's context from the database (AgentMessage).
 *
 * Verifies that:
 * 1. loadConversationHistory loads the last N USER and ASSISTANT messages in chronological order.
 * 2. Raw tool payloads (TOOL_CALL, TOOL_RESULT, ERROR) are excluded from the loaded history.
 * 3. The loaded messages reach the model across simulated process restarts (empty in-process MemorySaver).
 * 4. Regenerate uses the rewound history without duplicating or retaining dropped assistant turns.
 */

process.env.REDIS_ENABLED = 'false';
process.env.DATABASE_CONNECTION_LIMIT = '5';
process.env.AI_AGENT_ENABLED = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

const prisma = require('../src/config/db');
const {
  getOrCreateConversation,
  recordTurn,
  loadConversationHistory,
  rewindToLastUserMessage,
} = require('../src/services/agent/conversationService');
const { answerQuestion } = require('../src/services/agent/agentService');
const { createAgentGraph } = require('../src/services/agent/graph');
const { AIMessage } = require('@langchain/core/messages');

const ADMIN_ID = 1;
const createdConversations = [];

async function newConversation() {
  const conv = await getOrCreateConversation({ prisma, adminId: ADMIN_ID });
  createdConversations.push(conv.id);
  return conv;
}

test.after(async () => {
  for (const id of createdConversations) {
    await prisma.agentConversation.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
});

test('loadConversationHistory loads chronological USER and ASSISTANT messages and skips tool payloads', async () => {
  const conv = await newConversation();

  // Create messages in order: USER -> TOOL_CALL -> TOOL_RESULT -> ASSISTANT -> USER -> ASSISTANT
  await prisma.agentMessage.createMany({
    data: [
      { conversationId: conv.id, role: 'USER', content: 'السؤال الأول' },
      { conversationId: conv.id, role: 'TOOL_CALL', toolName: 'count_students', content: null },
      { conversationId: conv.id, role: 'TOOL_RESULT', toolName: 'count_students', content: '{"count": 50}' },
      { conversationId: conv.id, role: 'ASSISTANT', content: 'الإجابة الأولى' },
      { conversationId: conv.id, role: 'USER', content: 'السؤال الثاني' },
      { conversationId: conv.id, role: 'ASSISTANT', content: 'الإجابة الثانية' },
    ],
  });

  const history = await loadConversationHistory({ prisma, conversationId: conv.id, limit: 10 });

  assert.equal(history.length, 4, 'only USER and ASSISTANT messages loaded');
  assert.equal(history[0].role, 'USER');
  assert.equal(history[0].content, 'السؤال الأول');
  assert.equal(history[1].role, 'ASSISTANT');
  assert.equal(history[1].content, 'الإجابة الأولى');
  assert.equal(history[2].role, 'USER');
  assert.equal(history[2].content, 'السؤال الثاني');
  assert.equal(history[3].role, 'ASSISTANT');
  assert.equal(history[3].content, 'الإجابة الثانية');
});

test('model context survives a restart by hydrating from the database', async () => {
  const conv = await newConversation();

  // Seed turn 1 in DB
  await recordTurn({
    prisma,
    adminId: ADMIN_ID,
    conversationId: conv.id,
    question: 'ما هي عاصمة مصر؟',
    answer: 'عاصمة مصر هي القاهرة.',
  });

  // Turn 2 with simulated fresh graph (re-instantiated graph, fresh thread)
  const observedMessages = [];
  const graphFactory = (options) =>
    createAgentGraph({
      ...options,
      invokeModel: async (messages) => {
        observedMessages.push(...messages);
        return { result: new AIMessage('القاهرة مدينة تاريخية كبيرة.'), provider: 'scripted' };
      },
    });

  const result = await answerQuestion({
    question: 'وهل هي أكبر مدنها؟',
    adminId: ADMIN_ID,
    conversationId: conv.id,
    prisma,
    graphFactory,
  });

  assert.ok(result.ok, 'turn 2 succeeded');

  // Verify that the model was shown the prior turn from the DB
  const humanMessages = observedMessages.filter((m) => m.getType && m.getType() === 'human');
  const aiMessages = observedMessages.filter((m) => m.getType && m.getType() === 'ai');

  assert.ok(humanMessages.some((m) => m.content === 'ما هي عاصمة مصر؟'), 'prior user message hydrated from DB');
  assert.ok(aiMessages.some((m) => m.content === 'عاصمة مصر هي القاهرة.'), 'prior assistant message hydrated from DB');
  assert.equal(humanMessages[humanMessages.length - 1].content, 'وهل هي أكبر مدنها؟', 'current question is last');
});

test('regenerate correctly reflects rewound database state in model context', async () => {
  const conv = await newConversation();

  await recordTurn({
    prisma,
    adminId: ADMIN_ID,
    conversationId: conv.id,
    question: 'سؤال يتم حذفه لاحقاً',
    answer: 'رد سيتم التراجع عنه',
  });

  // Rewind
  const rewound = await rewindToLastUserMessage({
    prisma,
    adminId: ADMIN_ID,
    conversationId: conv.id,
    content: 'سؤال معدّل بديل',
  });

  assert.equal(rewound.question, 'سؤال معدّل بديل');

  // Re-run
  const observedMessages = [];
  const graphFactory = (options) =>
    createAgentGraph({
      ...options,
      invokeModel: async (messages) => {
        observedMessages.push(...messages);
        return { result: new AIMessage('رد جديد تماماً.'), provider: 'scripted' };
      },
    });

  const result = await answerQuestion({
    question: rewound.question,
    adminId: ADMIN_ID,
    conversationId: conv.id,
    prisma,
    graphFactory,
  });

  assert.ok(result.ok);

  // The model must NOT see the dropped assistant message in context
  const aiMessages = observedMessages.filter((m) => m.getType && m.getType() === 'ai');
  assert.ok(!aiMessages.some((m) => m.content === 'رد سيتم التراجع عنه'), 'dropped answer is not present in model context');
});
