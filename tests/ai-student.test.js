'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const config = require('../src/config/env');
const { buildSystemPrompt } = require('../src/services/aiStudent/systemPrompt');
const { sendMessage } = require('../src/services/aiStudent/aiStudentService');
const { chat, FRIENDLY_ERROR_MESSAGE } = require('../src/controllers/aiStudentController');
const { authenticateToken } = require('../src/middlewares/index');

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
}

test('AI Student: System Prompt interpolates subject and platform correctly', () => {
  const promptDefault = buildSystemPrompt();
  assert.ok(promptDefault.includes(config.aiStudent.subject));
  assert.ok(promptDefault.includes(config.aiStudent.platformName));

  const promptCustom = buildSystemPrompt({
    subject: 'التاريخ',
    platformName: 'منصة الأوائل',
  });
  assert.ok(promptCustom.includes('أنت مدرس التاريخ'));
  assert.ok(promptCustom.includes('منصة الأوائل'));
  assert.ok(promptCustom.includes('الثانوية العامة في مصر'));
  assert.ok(promptCustom.includes('4 إلى 8 سطور'));
});

test('AI Student: Dynamic model resolution from Admin Agent config', () => {
  assert.ok(config.aiStudent, 'aiStudent config must exist');
  assert.equal(config.aiStudent.model, config.aiAgent.primaryModel);
  assert.notEqual(config.aiStudent.model, 'gemini-1.5-flash');
});

test('AI Student: Service loads last 20 messages in strictly chronological order', async () => {
  // Simulate 25 messages with increasing createdAt
  const mockDbMessages = [];
  for (let i = 1; i <= 25; i++) {
    mockDbMessages.push({
      id: i,
      userId: 10,
      sessionId: 'session-uuid-1',
      role: i % 2 === 1 ? 'USER' : 'ASSISTANT',
      content: `Message ${i}`,
      createdAt: new Date(Date.now() - (25 - i) * 1000),
    });
  }

  let capturedFindArgs = null;
  let receivedModelMessages = null;
  const createdRecords = [];

  const mockPrisma = {
    aiStudentMessage: {
      findMany: async (args) => {
        capturedFindArgs = args;
        // Simulate Prisma: where match, orderBy desc, take limit
        const filtered = mockDbMessages
          .filter((m) => m.userId === args.where.userId && m.sessionId === args.where.sessionId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, args.take);
        return filtered;
      },
      create: async ({ data }) => {
        createdRecords.push(data);
        return { id: createdRecords.length, ...data, createdAt: new Date() };
      },
    },
    $transaction: async (promises) => Promise.all(promises),
  };

  const mockLlmProvider = {
    invokeWithFailover: async (callback, options) => {
      assert.equal(options.model, config.aiStudent.model);
      const fakeModel = {
        invoke: async (messages) => {
          receivedModelMessages = messages;
          return { content: 'إجابة نموذجية تجريبية' };
        },
      };
      const result = await callback(fakeModel);
      return { result, provider: 'gemini', model: options.model, attempts: [] };
    },
  };

  const response = await sendMessage(
    { userId: 10, sessionId: 'session-uuid-1', message: 'Message 26 (Current)' },
    { prisma: mockPrisma, llmProvider: mockLlmProvider }
  );

  assert.equal(response.reply, 'إجابة نموذجية تجريبية');

  // Verify findMany was called with take: 20 and orderBy: desc
  assert.equal(capturedFindArgs.where.userId, 10);
  assert.equal(capturedFindArgs.where.sessionId, 'session-uuid-1');
  assert.equal(capturedFindArgs.take, 20);
  assert.deepEqual(capturedFindArgs.orderBy, { createdAt: 'desc' });

  // Verify messages passed to Gemini:
  // [0] is SystemMessage
  // [1..20] must be Message 6 through Message 25 in chronological order
  // [21] is the current user message (Message 26)
  assert.equal(receivedModelMessages.length, 22);
  assert.equal(receivedModelMessages[0].constructor.name, 'SystemMessage');
  assert.equal(receivedModelMessages[1].content, 'Message 6');
  assert.equal(receivedModelMessages[2].content, 'Message 7');
  assert.equal(receivedModelMessages[20].content, 'Message 25');
  assert.equal(receivedModelMessages[21].content, 'Message 26 (Current)');

  // Verify both user and assistant messages were saved in DB
  assert.equal(createdRecords.length, 2);
  assert.equal(createdRecords[0].role, 'USER');
  assert.equal(createdRecords[0].content, 'Message 26 (Current)');
  assert.equal(createdRecords[1].role, 'ASSISTANT');
  assert.equal(createdRecords[1].content, 'إجابة نموذجية تجريبية');
});

test('AI Student: Strict user and session scoping (no cross-leak)', async () => {
  const store = [
    { id: 1, userId: 10, sessionId: 'session-A', role: 'USER', content: 'U10-A-1', createdAt: new Date(1000) },
    { id: 2, userId: 10, sessionId: 'session-B', role: 'USER', content: 'U10-B-1', createdAt: new Date(2000) },
    { id: 3, userId: 20, sessionId: 'session-A', role: 'USER', content: 'U20-A-1', createdAt: new Date(3000) },
  ];

  let receivedModelMessages = null;
  const mockPrisma = {
    aiStudentMessage: {
      findMany: async (args) => {
        return store.filter(
          (m) => m.userId === args.where.userId && m.sessionId === args.where.sessionId
        );
      },
      create: async ({ data }) => ({ id: 4, ...data }),
    },
    $transaction: async (promises) => Promise.all(promises),
  };

  const mockLlmProvider = {
    invokeWithFailover: async (callback) => {
      const fakeModel = {
        invoke: async (messages) => {
          receivedModelMessages = messages;
          return { content: 'رد' };
        },
      };
      const result = await callback(fakeModel);
      return { result, provider: 'gemini', model: 'test', attempts: [] };
    },
  };

  await sendMessage(
    { userId: 10, sessionId: 'session-A', message: 'U10-A-2' },
    { prisma: mockPrisma, llmProvider: mockLlmProvider }
  );

  // History should ONLY have U10-A-1 (plus system and current message)
  assert.equal(receivedModelMessages.length, 3);
  assert.equal(receivedModelMessages[1].content, 'U10-A-1');
  assert.equal(receivedModelMessages[2].content, 'U10-A-2');
});

test('AI Student: Failed Gemini call saves NOTHING to DB and throws', async () => {
  let createCalled = false;
  let transactionCalled = false;

  const mockPrisma = {
    aiStudentMessage: {
      findMany: async () => [],
      create: async () => {
        createCalled = true;
      },
    },
    $transaction: async () => {
      transactionCalled = true;
    },
  };

  const mockLlmProvider = {
    invokeWithFailover: async () => {
      throw new Error('Gemini API 503 Overloaded');
    },
  };

  await assert.rejects(
    async () => {
      await sendMessage(
        { userId: 10, sessionId: 'session-fail', message: 'سؤال' },
        { prisma: mockPrisma, llmProvider: mockLlmProvider }
      );
    },
    { message: 'Gemini API 503 Overloaded' }
  );

  assert.equal(createCalled, false, 'Prisma create must NOT be called on failure');
  assert.equal(transactionCalled, false, 'Prisma $transaction must NOT be called on failure');
});

test('AI Student: Controller & Route - 401 when unauthenticated', () => {
  const req = {
    cookies: {},
    headers: {},
  };
  const res = createMockRes();
  let nextCalled = false;

  authenticateToken(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
});

test('AI Student: Controller - 400 validation on empty, missing sessionId, and >500 chars', async () => {
  const reqUser = { user: { id: 10 } };

  // Empty sessionId
  {
    const res = createMockRes();
    await chat({ ...reqUser, body: { sessionId: '', message: 'مرحبا' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
  }

  // Missing message
  {
    const res = createMockRes();
    await chat({ ...reqUser, body: { sessionId: 'uuid-1', message: '   ' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
  }

  // Oversized message (> 500 chars)
  {
    const res = createMockRes();
    const longMessage = 'أ'.repeat(501);
    await chat({ ...reqUser, body: { sessionId: 'uuid-1', message: longMessage } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.ok(res.body.error.includes('500'));
  }
});

test('AI Student: Controller - 200 on success and 503 with friendly message on Gemini error', async () => {
  const originalSendMessage = require('../src/services/aiStudent/aiStudentService').sendMessage;

  // Test 200
  try {
    require('../src/services/aiStudent/aiStudentService').sendMessage = async () => ({
      reply: 'إجابة الشرح من المعلم',
    });

    const res = createMockRes();
    await chat(
      {
        user: { id: 10 },
        body: { sessionId: 'uuid-test', message: 'ما هو الفاعل؟' },
      },
      res
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { reply: 'إجابة الشرح من المعلم' });
  } finally {
    require('../src/services/aiStudent/aiStudentService').sendMessage = originalSendMessage;
  }

  // Test 503 friendly error
  try {
    require('../src/services/aiStudent/aiStudentService').sendMessage = async () => {
      throw new Error('Upstream LLM network timeout');
    };

    const res = createMockRes();
    await chat(
      {
        user: { id: 10 },
        body: { sessionId: 'uuid-test', message: 'ما هو الفاعل؟' },
      },
      res
    );

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, FRIENDLY_ERROR_MESSAGE);
    // Never leak stack trace or internal error details
    assert.ok(!JSON.stringify(res.body).includes('network timeout'));
  } finally {
    require('../src/services/aiStudent/aiStudentService').sendMessage = originalSendMessage;
  }
});
