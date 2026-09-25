'use strict';

/**
 * Phase 3 — conversation persistence (live DB, verifying a teammate's module).
 *
 * The rule that matters here is ownership: a conversation belongs to one admin, and
 * every read and write must prove it. The rest is contract shape — the UI must be
 * able to render history without ever receiving tool internals.
 */

process.env.REDIS_ENABLED = 'false';
process.env.DATABASE_CONNECTION_LIMIT = '5';

const test = require('node:test');
const assert = require('node:assert/strict');

const prisma = require('../src/config/db');
const {
  AgentConversationError,
  buildTitle,
  getOrCreateConversation,
  appendMessage,
  recordTurn,
  listConversations,
  getMessages,
} = require('../src/services/agent/conversationService');

const ADMIN_ID = 1;
const OTHER_ADMIN_ID = 999999; // not a real user: ownership is a field comparison
const created = [];

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof AgentConversationError, `expected AgentConversationError, got ${err.name}`);
    assert.equal(err.code, code);
    return true;
  });
}

async function newConversation() {
  const conversation = await getOrCreateConversation({ prisma, adminId: ADMIN_ID });
  created.push(conversation.id);
  return conversation;
}

test('titles are derived from the question, never invented', () => {
  assert.equal(buildTitle('كم عدد الطلاب؟'), 'كم عدد الطلاب؟');
  assert.equal(buildTitle('   مسافات   كثيرة  '), 'مسافات كثيرة');
  assert.equal(buildTitle('سطر أول\nسطر ثانٍ'), 'سطر أول');
  assert.equal(buildTitle('ن'.repeat(120)).length, 80, 'a long question is cut, not summarised');
  assert.equal(buildTitle('   '), 'محادثة جديدة');
});

test('a new conversation is created once and then reused', async () => {
  const first = await newConversation();
  assert.ok(Number.isSafeInteger(first.id));
  assert.equal(first.title, null, 'the title arrives with the first question');

  const again = await getOrCreateConversation({ prisma, adminId: ADMIN_ID, conversationId: first.id });
  assert.equal(again.id, first.id);
});

test('another admin cannot touch someone else’s conversation', async () => {
  const mine = await newConversation();
  await expectCode(
    getOrCreateConversation({ prisma, adminId: OTHER_ADMIN_ID, conversationId: mine.id }),
    'NOT_OWNED'
  );
  await expectCode(getMessages({ prisma, adminId: OTHER_ADMIN_ID, conversationId: mine.id }), 'NOT_OWNED');
  await expectCode(
    appendMessage({ prisma, adminId: OTHER_ADMIN_ID, conversationId: mine.id, role: 'USER', content: 'مرحبا' }),
    'NOT_OWNED'
  );
});

test('message roles are validated, and blank questions are refused', async () => {
  const conversation = await newConversation();
  const base = { prisma, adminId: ADMIN_ID, conversationId: conversation.id };

  await expectCode(appendMessage({ ...base, role: 'SYSTEM', content: 'x' }), 'INVALID_INPUT');
  await expectCode(appendMessage({ ...base, role: 'USER', content: '   ' }), 'EMPTY_MESSAGE');
  await expectCode(appendMessage({ ...base, role: 'ASSISTANT', content: '' }), 'EMPTY_MESSAGE');

  // Tool rows carry no text on purpose: their content is the tool payload.
  const toolRow = await appendMessage({
    ...base,
    role: 'TOOL_CALL',
    content: null,
    toolName: 'platform_overview',
    toolArgs: { take: 3 },
  });
  assert.ok(Number.isSafeInteger(toolRow.id));
});

test('a turn persists the question, the answer and the derived title', async () => {
  const conversation = await newConversation();
  const turn = await recordTurn({
    prisma,
    adminId: ADMIN_ID,
    conversationId: conversation.id,
    question: 'كم طالب في المنصة؟',
    answer: '### الطلاب\n\n| الصف | العدد |',
    metadata: { deterministic: true, latencyMs: 42 },
  });

  assert.equal(turn.conversationId, conversation.id);
  assert.equal(turn.title, 'كم طالب في المنصة؟');

  const messages = await getMessages({ prisma, adminId: ADMIN_ID, conversationId: conversation.id });
  assert.deepEqual(
    messages.map((m) => m.role),
    ['USER', 'ASSISTANT']
  );
  assert.equal(messages[0].content, 'كم طالب في المنصة؟');

  // A second turn must not rename an established conversation.
  const second = await recordTurn({
    prisma,
    adminId: ADMIN_ID,
    conversationId: conversation.id,
    question: 'سؤال آخر تماماً',
    answer: 'إجابة',
  });
  assert.equal(second.title, 'كم طالب في المنصة؟');
  const after = await getMessages({ prisma, adminId: ADMIN_ID, conversationId: conversation.id });
  assert.equal(after.length, 4);
});

test('history is oldest-first and never leaks tool internals', async () => {
  const conversation = await newConversation();
  await recordTurn({
    prisma,
    adminId: ADMIN_ID,
    conversationId: conversation.id,
    question: 'سؤال',
    answer: 'إجابة',
    metadata: { provider: 'groq', latencyMs: 900 },
  });

  const messages = await getMessages({ prisma, adminId: ADMIN_ID, conversationId: conversation.id, take: 100 });
  assert.ok(messages.length >= 2);
  for (const message of messages) {
    const keys = Object.keys(message).sort();
    for (const forbidden of ['toolArgs', 'toolResult', 'metadata']) {
      assert.ok(!keys.includes(forbidden), `getMessages must not return ${forbidden}`);
    }
    if (message.createdAt) {
      assert.ok(!Number.isNaN(Date.parse(message.createdAt)), 'createdAt must be an ISO string');
    }
  }
});

test('the conversation list is newest-first and clamped', async () => {
  const conversation = await newConversation();
  await recordTurn({
    prisma,
    adminId: ADMIN_ID,
    conversationId: conversation.id,
    question: 'أحدث محادثة',
    answer: 'تم',
  });

  const list = await listConversations({ prisma, adminId: ADMIN_ID, take: 10 });
  assert.ok(Array.isArray(list) && list.length >= 1);
  assert.equal(list[0].id, conversation.id, 'the most recently updated conversation comes first');
  assert.equal(list[0].title, 'أحدث محادثة');
  assert.ok(list[0].messageCount >= 2, 'the list must expose a message count');
  assert.ok(!Number.isNaN(Date.parse(list[0].updatedAt)));

  const much = await listConversations({ prisma, adminId: ADMIN_ID, take: 999 });
  assert.ok(much.length <= 50, 'take must be clamped');

  for (const row of list) {
    assert.ok(!Object.keys(row).includes('messages'), 'the list must not embed messages');
  }
});

test('cleanup', async () => {
  await prisma.agentConversation.deleteMany({ where: { id: { in: created } } });
  const leftovers = await prisma.agentConversation.count({ where: { id: { in: created } } });
  const orphanMessages = await prisma.agentMessage.count({ where: { conversationId: { in: created } } });
  assert.equal(leftovers, 0, 'this suite must leave no conversations behind');
  assert.equal(orphanMessages, 0, 'messages must cascade with their conversation');
  await prisma.$disconnect();
});

