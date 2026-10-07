'use strict';

/**
 * Phase 7 — cross-conversation memory against the REAL database.
 *
 * The pure suite (tests/agent-memory.test.js) pins the logic against a stub. This file
 * answers the two questions a stub cannot:
 *   1. Does the AgentMemory table actually exist with the columns the code names — i.e.
 *      is the 20261001000000 migration really applied to this database?
 *   2. Does a remembered fact survive the whole chain: table → the per-turn loader
 *      closure agentService builds (scoped to the calling admin) → the system prompt the
 *      model is shown on a Tier-2 turn?
 *
 * Per the Phase 6 handoff, the definition-of-done for "the memory was used" is a turn
 * whose `detail.declinedReason` proves it reached Tier 2 rather than a cached template.
 * Everything is net-zero: every row this file creates it deletes in `cleanup`.
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
const { createAgentGraph } = require('../src/services/agent/graph');
const { MEMORY_TURN_LIMIT, loadMemoriesForTurn, pruneExpiredMemories } = require('../src/services/agent/memoryService');

// AgentMemory.adminId is a real FK to User(id), so an owner must be a real admin —
// unlike the conversation suites, an invented id would fail on the constraint rather
// than on the assertion. Read-side scoping uses a NONEXISTENT id: no row can belong to
// it, which is exactly the shape of "another admin asks".
const ADMIN_ID = 1;
const GHOST_ADMIN_ID = 999999;

const FACT = 'المشرف يفضل أن تكون التقارير مختصرة في ثلاث نقاط';
const createdMemories = [];
const createdConversations = [];

function track(conversationId) {
  if (conversationId && !createdConversations.includes(conversationId)) createdConversations.push(conversationId);
}

test('the memory table exists and one fact round-trips through the three tools', async () => {
  const remember = await execute(getDefinition('remember_fact'), { content: FACT }, { prisma, adminId: ADMIN_ID });
  assert.equal(remember.data.ok, true, `remember_fact failed: ${JSON.stringify(remember.data)}`);
  createdMemories.push(remember.data.targetId);

  const list = await execute(getDefinition('list_memories'), {}, { prisma, adminId: ADMIN_ID });
  assert.ok(
    list.data.memories.some((m) => m.id === remember.data.targetId && m.content === FACT),
    'the fact the agent stored must be the fact the agent reads back, verbatim'
  );

  // The id is real, so a foreign admin CAN name it — and must still be told nothing is
  // there. (The refusal's audit row is then skipped by the AuditLog.actorId FK, because
  // 999999 is not a user: best-effort auditing working exactly as designed.)
  const foreign = await execute(
    getDefinition('forget_fact'),
    { memoryId: remember.data.targetId },
    { prisma, adminId: GHOST_ADMIN_ID }
  );
  assert.equal(foreign.data.ok, false);
  assert.equal(foreign.data.reason, 'MEMORY_NOT_FOUND');
  assert.ok(await prisma.agentMemory.findUnique({ where: { id: remember.data.targetId } }), 'the row survived the foreign call');

  const mine = await execute(
    getDefinition('forget_fact'),
    { memoryId: remember.data.targetId },
    { prisma, adminId: ADMIN_ID }
  );
  assert.equal(mine.data.ok, true);
  assert.equal(await prisma.agentMemory.findUnique({ where: { id: remember.data.targetId } }), null);
});

test('the per-turn loader reads its own admin’s rows and nothing else', async () => {
  const keep = ['نقطة أولى للحفظ', 'نقطة ثانية للحفظ'];
  for (const content of keep) {
    const row = await prisma.agentMemory.create({ data: { adminId: ADMIN_ID, content } });
    createdMemories.push(row.id);
  }

  const mine = await loadMemoriesForTurn({ prisma, adminId: ADMIN_ID });
  for (const content of keep) assert.ok(mine.includes(content), `${content} must be in its admin’s block`);
  assert.ok(mine.length <= MEMORY_TURN_LIMIT);

  assert.deepEqual(
    await loadMemoriesForTurn({ prisma, adminId: GHOST_ADMIN_ID }),
    [],
    'an admin with no facts gets no block at all'
  );
});

test('a remembered fact reaches the prompt of a Tier-2 turn', async () => {
  const row = await prisma.agentMemory.create({ data: { adminId: ADMIN_ID, content: FACT } });
  createdMemories.push(row.id);

  const seam = {};
  let shown = null;
  const agentConfig = config.aiAgent;
  const snapshot = { configured: agentConfig.configured };
  agentConfig.configured = true; // the model below is scripted: no key, no network
  try {
    const result = await answerQuestion({
      // Deliberately outside the deterministic catalogue, so the turn MUST reach the
      // model — the tier is what makes this a memory test and not a template test.
      question: 'اشرحلي نظرية النسبية ببساطة',
      adminId: ADMIN_ID,
      prisma,
      graphFactory: (options) => {
        Object.assign(seam, options);
        return createAgentGraph({
          ...options,
          invokeModel: async (messages) => {
            shown = messages;
            return { result: new AIMessage({ content: 'النسبية ببساطة: الزمن والمكان يتغيران.' }), provider: 'scripted' };
          },
        });
      },
    });
    await track(result.conversationId);

    assert.equal(result.ok, true, `the turn failed: ${JSON.stringify(result)}`);
    assert.equal(result.source, 'llm');
    assert.equal(result.detail.declinedReason, 'NO_INTENT', 'Tier 1 declined: this answer came from the model');

    // The security shape of the seam: the graph is handed a FUNCTION, never an adminId
    // or a prisma client. It cannot ask for someone else’s facts because it cannot name
    // them — the identity lives in this file’s closure.
    assert.equal(typeof seam.loadTurnMemories, 'function', 'the service hands the graph a loader, not an identity');
    const loaded = await seam.loadTurnMemories();
    assert.ok(loaded.includes(FACT), 'the loader the service built reads THIS admin’s rows');

    assert.ok(shown, 'the model call happened');
    assert.ok(shown[0].content.includes(FACT), 'the model was SHOWN the fact in its system prompt');
    assert.ok(shown[0].content.includes('معلومات محفوظة عن المشرف والمنصة'), 'labelled as remembered, not as something just said');
  } finally {
    agentConfig.configured = snapshot.configured;
  }
});

test('retention against this database: a window wider than the data deletes nothing', async () => {
  const before = await prisma.agentMemory.count({ where: { adminId: ADMIN_ID } });
  const result = await pruneExpiredMemories({ prisma, retentionDays: 3650 });

  assert.equal(result.deleted, 0, 'nothing in a young deployment is ten years old');
  assert.equal(result.remaining, 0);
  assert.equal(await prisma.agentMemory.count({ where: { adminId: ADMIN_ID } }), before, 'a sweep inside the window is inert');

  assert.deepEqual(
    await pruneExpiredMemories({ prisma, retentionDays: 0 }),
    { deleted: 0, remaining: null, disabled: true },
    'the documented “0 disables” contract holds against the real client too'
  );
});

test('cleanup', async () => {
  await prisma.agentMemory.deleteMany({ where: { id: { in: createdMemories } } });
  await prisma.agentConversation.deleteMany({ where: { id: { in: createdConversations } } });

  assert.equal(await prisma.agentMemory.count({ where: { id: { in: createdMemories } } }), 0, 'no memory row survives this suite');
  assert.equal(await prisma.agentConversation.count({ where: { id: { in: createdConversations } } }), 0, 'no conversation survives either');
  await prisma.$disconnect();
});

