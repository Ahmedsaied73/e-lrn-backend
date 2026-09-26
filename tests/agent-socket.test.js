'use strict';

/**
 * Phase 4 — the agent's WebSocket surface (offline: no server, no network).
 *
 * The socket layer is split on purpose: authentication and every event handler are
 * pure functions of { socket, services }, so the contract below is verifiable with
 * a fake socket. The only untested lines are inside initAgentSocket, which is a
 * thin "create + attach" wrapper by the same rule as the other wiring.
 */

process.env.REDIS_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

const jwt = require('jsonwebtoken');
const config = require('../src/config/env');
const {
  SOCKET_PATH,
  authenticateSocket,
  registerAgentHandlers,
  initAgentSocket,
  readAccessToken,
  parseCookieHeader,
} = require('../src/services/agent/socketHandler');

/** A socket that records everything instead of transmitting it. */
function fakeSocket(headers = {}, agent = null) {
  const handlers = {};
  const emitted = [];
  return {
    handshake: { headers },
    agent,
    handlers,
    emitted,
    on(event, fn) {
      handlers[event] = fn;
    },
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    last(eventName) {
      const matches = emitted.filter((e) => e.event === eventName);
      return matches.length ? matches[matches.length - 1] : null;
    },
  };
}

const sign = (payload, options) => jwt.sign(payload, config.jwt.secret, options);
const ADMIN_ID = 1;

async function runAuth(headers) {
  const socket = fakeSocket(headers);
  const error = await new Promise((resolve) => authenticateSocket(socket, resolve));
  return { socket, error };
}

test('the socket endpoint path is stable', () => {
  assert.equal(SOCKET_PATH, '/agent-ws');
  assert.equal(typeof initAgentSocket, 'function');
});

test('cookies parse into name/value pairs', () => {
  assert.deepEqual(parseCookieHeader('accessToken=abc; token=def'), { accessToken: 'abc', token: 'def' });
  assert.deepEqual(parseCookieHeader('accessToken=abc'), { accessToken: 'abc' });
  assert.deepEqual(parseCookieHeader(''), {});
  assert.deepEqual(parseCookieHeader(null), {});
  assert.deepEqual(parseCookieHeader('no-equals-here'), {});
});

test('the access token is read from the same cookies the REST layer trusts', () => {
  assert.equal(readAccessToken({ cookie: 'accessToken=abc123' }), 'abc123');
  assert.equal(readAccessToken({ cookie: 'token=xyz' }), 'xyz');
  assert.equal(readAccessToken({ cookie: 'session=no-agent-token' }), null);
  assert.equal(readAccessToken({}), null);
  assert.equal(readAccessToken(null), null);
});

test('no cookie means no session', async () => {
  const { error } = await runAuth({});
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'AUTH_REQUIRED');
});

test('a broken token is rejected, not retried', async () => {
  const { error } = await runAuth({ cookie: 'accessToken=this.is.not.a.jwt' });
  assert.equal(error.message, 'AUTH_FAILED');
});

test('a refresh token cannot open a chat session', async () => {
  const { error } = await runAuth({ cookie: `accessToken=${sign({ id: ADMIN_ID, type: 'refresh' })}` });
  assert.equal(error.message, 'INVALID_TOKEN');
});

test('an expired access token is rejected', async () => {
  const { error } = await runAuth({
    cookie: `accessToken=${sign({ id: ADMIN_ID, type: 'access' }, { expiresIn: '-10s' })}`,
  });
  assert.equal(error.message, 'AUTH_FAILED');
});

test('a valid access token authenticates the admin from the database', async () => {
  const token = sign({ id: ADMIN_ID, type: 'access' });
  const { socket, error } = await runAuth({ cookie: `accessToken=${token}` });
  assert.equal(error, undefined);
  assert.deepEqual(socket.agent, { adminId: ADMIN_ID, adminName: 'Site Administrator' });
});

test('a non-admin token is refused, and nothing is attached to the socket', async () => {
  // User 102155 exists and is a student in the seeded data — its token proves the
  // role comes from the database row, not from a client-claimed role field.
  const token = sign({ id: 102155, type: 'access' });
  const { socket, error } = await runAuth({ cookie: `accessToken=${token}` });
  assert.equal(error.message, 'ADMIN_REQUIRED');
  assert.equal(socket.agent, null);
});

test('handler registration requires an authenticated socket', () => {
  assert.throws(() => registerAgentHandlers(fakeSocket({}, null)), /authenticated socket/);
});

test('an empty or oversized question is rejected without touching the service', async () => {
  let called = 0;
  const socket = fakeSocket({}, { adminId: ADMIN_ID });
  registerAgentHandlers(socket, {
    answerQuestion: async () => {
      called += 1;
      return { ok: true };
    },
  });

  await socket.handlers['agent:message']({ question: '   ' });
  await socket.handlers['agent:message']({ question: 'x'.repeat(2001) });
  await socket.handlers['agent:message'](null);

  assert.equal(called, 0, 'validation must run before the service is ever called');
  const errors = socket.emitted.filter((e) => e.event === 'agent:error');
  assert.equal(errors.length, 3);
  assert.ok(errors.every((e) => e.payload.code === 'EMPTY_QUESTION'));
});

test('a question is forwarded, and the outcome is emitted whole', async () => {
  const seen = [];
  const socket = fakeSocket({}, { adminId: ADMIN_ID });
  registerAgentHandlers(socket, {
    answerQuestion: async (args) => {
      seen.push(args);
      return { ok: true, source: 'llm', answer: 'تم', conversationId: 9, detail: {} };
    },
  });

  await socket.handlers['agent:message']({ question: 'ملخص الإيرادات', conversationId: 9 });

  assert.equal(seen.length, 1);
  assert.deepEqual(
    { question: seen[0].question, adminId: seen[0].adminId, conversationId: seen[0].conversationId },
    { question: 'ملخص الإيرادات', adminId: ADMIN_ID, conversationId: 9 }
  );
  const complete = socket.last('agent:complete');
  assert.equal(complete.payload.ok, true);
  assert.equal(complete.payload.answer, 'تم');
});

test('a service failure becomes an error event, never a dropped socket', async () => {
  const socket = fakeSocket({}, { adminId: ADMIN_ID });
  registerAgentHandlers(socket, {
    answerQuestion: async () => {
      throw new Error('provider exploded');
    },
  });

  await socket.handlers['agent:message']({ question: 'مرحبا' });
  const error = socket.last('agent:error');
  assert.equal(error.payload.code, 'AGENT_ERROR');
  assert.doesNotMatch(error.payload.detail, /exploded/, 'internal details must not reach the client');
});

test('conversations and history are served for the session admin', async () => {
  const socket = fakeSocket({}, { adminId: ADMIN_ID });
  const seen = [];
  registerAgentHandlers(socket, {
    conversations: {
      listConversations: async ({ adminId }) => {
        seen.push(['list', adminId]);
        return [{ id: 3 }];
      },
      getMessages: async ({ adminId, conversationId }) => {
        seen.push(['get', adminId, conversationId]);
        return [{ id: 1, role: 'USER' }];
      },
    },
  });

  await socket.handlers['agent:conversations']();
  await socket.handlers['agent:history']({ conversationId: 3 });

  assert.deepEqual(seen, [
    ['list', ADMIN_ID],
    ['get', ADMIN_ID, 3],
  ]);
  assert.deepEqual(socket.last('agent:conversations').payload, { conversations: [{ id: 3 }] });
  assert.deepEqual(socket.last('agent:history').payload, { conversationId: 3, messages: [{ id: 1, role: 'USER' }] });
});

test('a foreign conversation id is reported as not found, not as a leak', async () => {
  const foreignError = new Error('belongs to another admin');
  foreignError.code = 'NOT_OWNED';
  const socket = fakeSocket({}, { adminId: ADMIN_ID });
  registerAgentHandlers(socket, {
    conversations: {
      getMessages: async () => {
        throw foreignError;
      },
    },
  });

  await socket.handlers['agent:history']({ conversationId: 424242 });
  assert.equal(socket.last('agent:error').payload.code, 'CONVERSATION_NOT_FOUND');
});

test('decisions require a well-formed request, and outcomes are namespaced', async () => {
  const socket = fakeSocket({}, { adminId: ADMIN_ID });
  registerAgentHandlers(socket, {
    approvals: {
      decideApproval: async ({ approvalId, approved }) => ({
        id: approvalId,
        status: approved ? 'APPROVED' : 'REJECTED',
        decidedBy: ADMIN_ID,
        decidedAt: '2026-09-25T10:00:00.000Z',
      }),
    },
  });

  await socket.handlers['agent:decide']({ approvalId: 11, approved: true });
  assert.deepEqual(socket.last('agent:decision').payload, {
    approvalId: 11,
    status: 'APPROVED',
    decidedBy: ADMIN_ID,
    decidedAt: '2026-09-25T10:00:00.000Z',
  });

  await socket.handlers['agent:decide']({ approvalId: 'junk', approved: true });
  assert.equal(socket.last('agent:error').payload.code, 'INVALID_DECISION');

  await socket.handlers['agent:decide']({ approvalId: 11 });
  assert.equal(socket.last('agent:error').payload.code, 'INVALID_DECISION');
});

test('an already-decided approval is reported distinctly from a missing one', async () => {
  const socket = fakeSocket({}, { adminId: ADMIN_ID });
  registerAgentHandlers(socket, {
    approvals: {
      decideApproval: async ({ approvalId }) => {
        if (approvalId === 99) return { id: 99, status: 'APPROVED', decidedBy: ADMIN_ID, decidedAt: 'now' };
        const err = new Error('already decided');
        err.code = 'NOT_PENDING';
        throw err;
      },
    },
  });

  await socket.handlers['agent:decide']({ approvalId: 99, approved: true });
  assert.equal(socket.last('agent:decision').payload.status, 'APPROVED');

  await socket.handlers['agent:decide']({ approvalId: 100, approved: false });
  assert.equal(socket.last('agent:error').payload.code, 'APPROVAL_ALREADY_DECIDED');
});


test('the per-admin turn budget also guards the socket (Phase 4.5)', async () => {
  // The socket was the cheaper path to an unlimited LLM bill: one authenticated
  // connection, no HTTP overhead, and — until this — no limiter at all. A refused
  // turn must not reach the service, or the budget is only a warning.
  let calls = 0;
  const socket = fakeSocket({}, { adminId: ADMIN_ID });
  let verdict = { allowed: true, code: null, retryAfterMs: null };
  registerAgentHandlers(socket, {
    answerQuestion: async () => {
      calls += 1;
      return { ok: true, source: 'llm', answer: 'تم', conversationId: 9, detail: {} };
    },
    limits: {
      checkAndCount: async () => verdict,
    },
  });

  // Allowed: the turn runs exactly as before.
  await socket.handlers['agent:message']({ question: 'ملخص الإيرادات' });
  assert.equal(calls, 1, 'an allowed turn must still reach the service');
  assert.equal(socket.last('agent:complete').payload.ok, true);

  // Per-minute refusal.
  verdict = { allowed: false, code: 'RATE_LIMITED', retryAfterMs: 120000 };
  await socket.handlers['agent:message']({ question: 'ملخص الإيرادات' });
  assert.equal(calls, 1, 'a refused turn must NOT reach the service');
  const limited = socket.last('agent:error').payload;
  assert.equal(limited.code, 'RATE_LIMITED');
  assert.equal(limited.retryAfterMs, 120000);
  // last() would still find the FIRST turn's completion, so count instead:
  assert.equal(socket.emitted.filter((e) => e.event === 'agent:complete').length, 1, 'no completion event for a refused turn');

  // Daily refusal is a DIFFERENT code, so a client can tell a slow minute from a
  // closed day and stop retrying until tomorrow.
  verdict = { allowed: false, code: 'DAILY_BUDGET_EXCEEDED', retryAfterMs: 3600000 };
  await socket.handlers['agent:message']({ question: 'ملخص الإيرادات' });
  assert.equal(calls, 1);
  assert.equal(socket.last('agent:error').payload.code, 'DAILY_BUDGET_EXCEEDED');
});

test('a limiter that throws fails OPEN — a socket turn is never lost to a limiter bug', async () => {
  const socket = fakeSocket({}, { adminId: ADMIN_ID });
  let calls = 0;
  registerAgentHandlers(socket, {
    answerQuestion: async () => {
      calls += 1;
      return { ok: true, source: 'llm', answer: 'تم', conversationId: 9, detail: {} };
    },
    limits: {
      checkAndCount: async () => {
        throw new Error('redis exploded');
      },
    },
  });

  await socket.handlers['agent:message']({ question: 'مرحبا' });
  assert.equal(calls, 1, 'a broken limiter must not become an outage');
  assert.equal(socket.last('agent:complete').payload.ok, true);
});
