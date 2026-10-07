'use strict';

/**
 * Phase 9 — conversation features: search, rename, delete, regenerate (live DB).
 *
 * These four routes are the first thing in the agent that lets an admin CHANGE or
 * REMOVE stored history, so the tests are built around the two ways that goes wrong:
 *   - reaching another admin's transcript (every route is ownership-gated), and
 *   - leaving something behind that should have died with the rewound turn (a stale
 *     confirmation token is the dangerous one — see rewindToLastUserMessage).
 *
 * Everything runs against the real database because the contracts ARE the queries:
 * a `contains` scoped through the owning conversation, and a delete cascade that must
 * take the transcript but NOT the memories.
 *
 * Net-zero: every conversation this file creates is deleted in `after`.
 */

process.env.REDIS_ENABLED = 'false';
process.env.DATABASE_CONNECTION_LIMIT = '5';

const test = require('node:test');
const assert = require('node:assert/strict');

const prisma = require('../src/config/db');
const {
  AgentConversationError,
  getOrCreateConversation,
  recordTurn,
  listConversations,
  getMessages,
  searchConversations,
  renameConversation,
  deleteConversation,
  rewindToLastUserMessage,
} = require('../src/services/agent/conversationService');

const ADMIN_ID = 1;
/** Not a real user id: ownership is a field comparison, so no FK is involved. */
const OTHER_ADMIN_ID = 999999;
const created = [];

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof AgentConversationError, `expected AgentConversationError, got ${err.name}`);
    assert.equal(err.code, code);
    return true;
  });
}

/** A conversation with one seeded turn, titled from its first question. */
async function seeded(question = 'كام طالب مسجل في المنصة؟', answer = 'فيه ١٢٠ طالب مسجل.') {
  const conversation = await getOrCreateConversation({ prisma, adminId: ADMIN_ID });
  created.push(conversation.id);
  await recordTurn({ prisma, adminId: ADMIN_ID, conversationId: conversation.id, question, answer });
  return conversation;
}

test.after(async () => {
  for (const id of created) {
    await prisma.agentConversation.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// POST/GET search
// ─────────────────────────────────────────────────────────────────────────────

test('search finds this admin’s message and says where it matched', async () => {
  const conversation = await seeded('عايز أعرف كل الطلاب اللي من غير دورة', 'تمام، هجيبلك القائمة.');
  const result = await searchConversations({ prisma, adminId: ADMIN_ID, q: 'الطلاب' });

  assert.ok(result.rows.length >= 1, 'the seeded question is findable');
  const hit = result.rows.find((row) => row.conversationId === conversation.id);
  assert.ok(hit, 'the hit names its conversation');
  assert.ok(Number.isSafeInteger(hit.messageId), 'and the matching message');
  assert.match(hit.snippet, /الطلاب/, 'the snippet shows the match in context');
  assert.equal(hit.title, 'عايز أعرف كل الطلاب اللي من غير دورة', 'the sidebar title rides along for the UI');
});

test('search is scoped to the caller: another admin sees nothing', async () => {
  await seeded('سرّي جداً: كلمة التفاح', 'ok');
  const mine = await searchConversations({ prisma, adminId: ADMIN_ID, q: 'التفاح' });
  assert.ok(mine.rows.length >= 1, 'the owner finds it');

  const theirs = await searchConversations({ prisma, adminId: OTHER_ADMIN_ID, q: 'التفاح' });
  assert.equal(theirs.rows.length, 0, 'and nobody else does — the filter is in the QUERY, not after it');
});

test('search refuses a query that is not a search', async () => {
  await expectCode(searchConversations({ prisma, adminId: ADMIN_ID, q: 'ا' }), 'INVALID_QUERY');
  await expectCode(searchConversations({ prisma, adminId: ADMIN_ID, q: '  ' }), 'INVALID_QUERY');
  await expectCode(searchConversations({ prisma, adminId: ADMIN_ID, q: 'x'.repeat(101) }), 'INVALID_QUERY');
});

test('search paginates by cursor and proves truncation', async () => {
  const conversation = await getOrCreateConversation({ prisma, adminId: ADMIN_ID });
  created.push(conversation.id);
  for (let i = 0; i < 3; i += 1) {
    await recordTurn({
      prisma,
      adminId: ADMIN_ID,
      conversationId: conversation.id,
      question: `سؤال متكرر رقم ${i} عن الطلاب`,
      answer: `رد ${i}`,
    });
  }

  const first = await searchConversations({ prisma, adminId: ADMIN_ID, q: 'سؤال متكرر رقم', take: 1 });
  assert.equal(first.rows.length, 1);
  assert.equal(first.truncated, true, 'take+1 makes truncation a fact, not a guess');
  assert.ok(Number.isSafeInteger(first.nextCursor), 'and hands back a cursor');

  const second = await searchConversations({
    prisma,
    adminId: ADMIN_ID,
    q: 'سؤال متكرر رقم',
    take: 1,
    cursor: first.nextCursor,
  });
  assert.equal(second.rows.length, 1);
  assert.notEqual(second.rows[0].messageId, first.rows[0].messageId, 'the cursor actually advances');
});


// ─────────────────────────────────────────────────────────────────────────────
// PATCH rename
// ─────────────────────────────────────────────────────────────────────────────

test('rename stores the admin’s own words, trimmed', async () => {
  const conversation = await seeded();
  const renamed = await renameConversation({
    prisma,
    adminId: ADMIN_ID,
    conversationId: conversation.id,
    title: '   تقرير الطلاب – أكتوبر   ',
  });
  assert.equal(renamed.title, 'تقرير الطلاب – أكتوبر');
  assert.equal(renamed.id, conversation.id);
});

test('rename validates the title before touching the row', async () => {
  const conversation = await seeded();
  const base = { prisma, adminId: ADMIN_ID, conversationId: conversation.id };
  await expectCode(renameConversation({ ...base, title: '   ' }), 'INVALID_TITLE');
  await expectCode(renameConversation({ ...base, title: 'x'.repeat(121) }), 'INVALID_TITLE');
  await expectCode(renameConversation({ ...base, title: undefined }), 'INVALID_TITLE');
});

test('rename of a conversation that is not yours is NOT FOUND, never 403', async () => {
  const conversation = await seeded();
  await expectCode(
    renameConversation({ prisma, adminId: OTHER_ADMIN_ID, conversationId: conversation.id, title: 'مسروق' }),
    'NOT_OWNED'
  );
  // and the owner's title is untouched by the attempt
  const rows = await listConversations({ prisma, adminId: ADMIN_ID });
  const row = rows.find((r) => r.id === conversation.id);
  assert.notEqual(row.title, 'مسروق');
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────────────────

test('delete removes the transcript but NOT the memories learned in it', async () => {
  const conversation = await seeded('افتكر إن سعر الكورس ٥٠٠ جنيه', 'تمام، حفظتها.');
  const memory = await prisma.agentMemory.create({
    data: { adminId: ADMIN_ID, content: 'سعر الكورس ٥٠٠ جنيه', sourceConversationId: conversation.id },
    select: { id: true },
  });

  await deleteConversation({ prisma, adminId: ADMIN_ID, conversationId: conversation.id });

  const messages = await prisma.agentMessage.count({ where: { conversationId: conversation.id } });
  assert.equal(messages, 0, 'the transcript cascades away with the parent');
  const gone = await prisma.agentConversation.findUnique({ where: { id: conversation.id } });
  assert.equal(gone, null);

  const survivor = await prisma.agentMemory.findUnique({
    where: { id: memory.id },
    select: { content: true, sourceConversationId: true },
  });
  assert.ok(survivor, '§9.1: deleting a chat must not un-teach the agent');
  assert.equal(survivor.content, 'سعر الكورس ٥٠٠ جنيه');
  assert.equal(survivor.sourceConversationId, null, 'only the provenance is cleared (SetNull)');

  await prisma.agentMemory.delete({ where: { id: memory.id } }).catch(() => {});
});

test('delete of a conversation that is not yours is NOT FOUND', async () => {
  const conversation = await seeded();
  await expectCode(deleteConversation({ prisma, adminId: OTHER_ADMIN_ID, conversationId: conversation.id }), 'NOT_OWNED');
  const still = await prisma.agentConversation.findUnique({ where: { id: conversation.id } });
  assert.ok(still, 'a refused delete changes nothing');

  await expectCode(deleteConversation({ prisma, adminId: ADMIN_ID, conversationId: 99999999 }), 'NOT_FOUND');
});

// ─────────────────────────────────────────────────────────────────────────────
// REWIND / REGENERATE
// ─────────────────────────────────────────────────────────────────────────────

test('rewindToLastUserMessage drops messages after last user message and expires pending approvals', async () => {
  const conversation = await seeded('سؤال أول', 'جواب أول');
  const user2 = await prisma.agentMessage.create({
    data: { conversationId: conversation.id, role: 'USER', content: 'سؤال تاني' },
  });
  const asst2 = await prisma.agentMessage.create({
    data: { conversationId: conversation.id, role: 'ASSISTANT', content: 'جواب تاني' },
  });
  const approval = await prisma.agentApproval.create({
    data: {
      adminId: ADMIN_ID,
      conversationId: conversation.id,
      toolName: 'broadcast_notification',
      args: { message: 'hello', channel: 'all' },
      argsHash: 'testhash',
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 60000),
      requestedAt: new Date(),
    },
  });

  const rewound = await rewindToLastUserMessage({
    prisma,
    adminId: ADMIN_ID,
    conversationId: conversation.id,
  });

  assert.equal(rewound.conversationId, conversation.id);
  assert.equal(rewound.question, 'سؤال تاني');
  assert.equal(rewound.userMessageId, user2.id);
  assert.equal(rewound.droppedMessages, 1, 'dropped asst2');
  assert.equal(rewound.expiredApprovals, 1, 'expired pending approval');

  // Verify DB state
  const asstStill = await prisma.agentMessage.findUnique({ where: { id: asst2.id } });
  assert.equal(asstStill, null, 'dropped assistant turn is gone');

  const approvalStatus = await prisma.agentApproval.findUnique({
    where: { id: approval.id },
    select: { status: true },
  });
  assert.equal(approvalStatus.status, 'EXPIRED', 'approval marked expired');
});

test('rewindToLastUserMessage with content replaces the user message content', async () => {
  const conversation = await seeded('سؤال قبل التعديل', 'جواب قديم');
  const rewound = await rewindToLastUserMessage({
    prisma,
    adminId: ADMIN_ID,
    conversationId: conversation.id,
    content: 'سؤال جديد بعد التعديل',
  });

  assert.equal(rewound.question, 'سؤال جديد بعد التعديل');
  const lastUser = await prisma.agentMessage.findUnique({ where: { id: rewound.userMessageId } });
  assert.equal(lastUser.content, 'سؤال جديد بعد التعديل');
});

test('rewindToLastUserMessage validates inputs and refuses empty or missing turns', async () => {
  const emptyConv = await getOrCreateConversation({ prisma, adminId: ADMIN_ID });
  created.push(emptyConv.id);

  await expectCode(
    rewindToLastUserMessage({ prisma, adminId: ADMIN_ID, conversationId: emptyConv.id }),
    'NO_USER_MESSAGE'
  );

  const conversation = await seeded();
  await expectCode(
    rewindToLastUserMessage({ prisma, adminId: ADMIN_ID, conversationId: conversation.id, content: '   ' }),
    'EMPTY_MESSAGE'
  );

  await expectCode(
    rewindToLastUserMessage({ prisma, adminId: ADMIN_ID, conversationId: conversation.id, content: 'x'.repeat(2001) }),
    'INVALID_INPUT'
  );

  await expectCode(
    rewindToLastUserMessage({ prisma, adminId: OTHER_ADMIN_ID, conversationId: conversation.id }),
    'NOT_OWNED'
  );
});

