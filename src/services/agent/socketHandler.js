'use strict';

/**
 * socketHandler.js — the agent's WebSocket surface (Phase 4).
 *
 * Units are split for testing: `authenticateSocket` and `registerAgentHandlers`
 * know nothing about a real server, so the whole surface (auth contract, event
 * names, message shapes, handler errors) is verifiable with a fake socket and no
 * network. `initAgentSocket` wires them to a real `socket.io` Server.
 *
 * Event contract (documented for the frontend chat, which lives outside this repo):
 *   client → server: 'agent:message'   { question, conversationId?, approvalId? }
 *                     'agent:decide'    { approvalId, approved }
 *                     'agent:conversations'
 *                     'agent:history'   { conversationId }
 *   server → client: 'agent:thinking'  { status }
 *                     'agent:tier'      { tier, intent? }
 *                     'agent:tool_call' { name, args? }
 *                     'agent:tool_result' { name, ok }
 *                     'agent:complete'  { ok, conversationId, answer, source, detail }
 *                     'agent:error'     { code, detail }
 *                     'agent:conversations' { conversations: [...] }
 *                     'agent:history'   { conversationId, messages: [...] }
 *                     'agent:decision'  { approvalId, status, ... }
 *
 * Two deliberate deviations from the earlier sketch:
 *   1. There is no 'agent:token' word-stream for model answers yet, because the
 *      grounding guard can only validate a COMPLETE answer. Progress events are
 *      live; the answer itself is emitted validated-or-not-at-all.
 *   2. Tool payloads are never sent: 'agent:tool_result' carries only a name and
 *      an ok flag. Raw payloads would duplicate the redaction surface into the
 *      browser.
 */

const jwt = require('jsonwebtoken');
const config = require('../../config/env');

const SOCKET_PATH = '/agent-ws';

/** Minimal RFC 6265 parser — enough for "name=value; name2=value2" headers. */
function parseCookieHeader(header) {
  const cookies = {};
  if (typeof header !== 'string' || !header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    if (!name || raw in cookies) continue;
    cookies[name] = raw;
  }
  return cookies;
}

/** The access token, from the same cookie the REST layer trusts; nothing else. */
function readAccessToken(headers) {
  const cookies = parseCookieHeader(headers && headers.cookie);
  return cookies.accessToken || cookies.token || null;
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Socket.io auth middleware. Same contract as authenticateToken + authorizeAdmin
 * for REST, minus the Bearer fallback: a browser chat sends cookies, and the
 * plan's sketch deliberately authenticates from them only.
 */
async function authenticateSocket(socket, next) {
  const prisma = require('../../config/db');
  try {
    const token = readAccessToken(socket && socket.handshake && socket.handshake.headers);
    if (!token) return next(new Error('AUTH_REQUIRED'));

    const decoded = jwt.verify(token, config.jwt.secret);
    if (!decoded || decoded.type !== 'access') return next(new Error('INVALID_TOKEN'));

    const admin = await prisma.user.findUnique({
      where: { id: Number(decoded.id) },
      select: { id: true, role: true, name: true },
    });
    if (!admin || admin.role !== 'ADMIN') return next(new Error('ADMIN_REQUIRED'));

    // Namespaced on purpose: reserve `socket.user` for nothing.
    socket.agent = { adminId: admin.id, adminName: admin.name || 'Admin' };
    return next();
  } catch {
    return next(new Error('AUTH_FAILED'));
  }
}

/**
 * Register the agent events on one connected, authenticated socket.
 *
 * Every handler speaks `{ ok, ... }` except the progress stream, and every one
 * of them resolves — throwing handlers detach sockets in silent ways, so the
 * catch below turns a bug into 'agent:error' instead of a dropped connection.
 */
function registerAgentHandlers(socket, { answerQuestion, conversations, approvals, prisma, limits } = {}) {
  const adminId = socket && socket.agent && socket.agent.adminId;
  if (!adminId) throw new Error('registerAgentHandlers requires an authenticated socket (socket.agent.adminId)');

  const service = answerQuestion || require('./agentService').answerQuestion;
  const conversationService = conversations || require('./conversationService');
  const approvalService = approvals || require('./approvals');
  const db = prisma || require('../../config/db');
  // Phase 4.5: the same per-admin turn budget the REST route enforces. Without it
  // the socket was the cheaper path to an unlimited LLM bill — one authenticated
  // connection, no HTTP overhead, no limiter. Injected so a test can drive the
  // budget without a real Redis.
  const turnBudget = limits || require('./limits').turnLimits();

  const forwardProgress = (type) => (event) => {
    socket.emit(type, event || {});
  };

  socket.on('agent:message', async (payload) => {
    const body = payload && typeof payload === 'object' ? payload : {};
    const question = typeof body.question === 'string' ? body.question : '';
    const conversationId = toPositiveInt(body.conversationId);
    const approvalId = toPositiveInt(body.approvalId);

    if (!question.trim() || question.length > 2000) {
      socket.emit('agent:error', { code: 'EMPTY_QUESTION', detail: 'question is required (max 2000 characters)' });
      return;
    }

    // The budget is checked BEFORE the service is called: a refused turn must not
    // reach the model, let alone the database.
    let verdict = { allowed: true, code: null, retryAfterMs: null };
    try {
      verdict = await turnBudget.checkAndCount(adminId);
    } catch {
      // Fail open: a limiter that throws must not become an outage.
    }
    if (!verdict.allowed) {
      socket.emit('agent:error', {
        code: verdict.code,
        detail:
          verdict.code === 'DAILY_BUDGET_EXCEEDED'
            ? 'Daily agent question budget exhausted, try again tomorrow.'
            : 'Too many agent requests, please wait a moment.',
        retryAfterMs: verdict.retryAfterMs,
      });
      return;
    }

    try {
      const result = await service({
        question,
        adminId,
        conversationId,
        approvalId,
        persist: true,
        prisma: db,
        onEvent: (event) => {
          // Answer content NEVER streams (grounding); only progress and the outcome.
          if (event && (event.type === 'thinking' || event.type === 'tier')) forwardProgress('agent:thinking')(event);
          if (event && event.type === 'tool_call') forwardProgress('agent:tool_call')(event);
          if (event && event.type === 'tool_result') forwardProgress('agent:tool_result')(event);
        },
      });
      socket.emit('agent:complete', result);
    } catch {
      // The failure is reported, never thrown: a socket handler that throws would
      // leave the admin watching a panel that never resolves.
      socket.emit('agent:error', { code: 'AGENT_ERROR', detail: 'failed to process the message' });
    }
  });

  socket.on('agent:conversations', async () => {
    try {
      const rows = await conversationService.listConversations({ prisma: db, adminId, take: 30 });
      socket.emit('agent:conversations', { conversations: rows });
    } catch {
      socket.emit('agent:error', { code: 'HISTORY_FAILED', detail: 'could not load conversations' });
    }
  });

  socket.on('agent:history', async (payload) => {
    const body = payload && typeof payload === 'object' ? payload : {};
    const conversationId = toPositiveInt(body.conversationId);
    if (!conversationId) {
      socket.emit('agent:error', { code: 'INVALID_CONVERSATION', detail: 'conversationId must be a positive integer' });
      return;
    }
    try {
      const messages = await conversationService.getMessages({ prisma: db, adminId, conversationId });
      socket.emit('agent:history', { conversationId, messages });
    } catch (err) {
      const code = err && err.code === 'NOT_OWNED' ? 'CONVERSATION_NOT_FOUND' : 'HISTORY_FAILED';
      socket.emit('agent:error', { code, detail: 'could not load conversation history' });
    }
  });

  // The human half of the interrupt: approve or reject a pending request.
  socket.on('agent:decide', async (payload) => {
    const body = payload && typeof payload === 'object' ? payload : {};
    const approvalId = toPositiveInt(body.approvalId);
    const approved = body.approved;
    if (!approvalId || (approved !== true && approved !== false)) {
      socket.emit('agent:error', { code: 'INVALID_DECISION', detail: '{ approvalId, approved: true|false } required' });
      return;
    }
    try {
      const data = await approvalService.decideApproval({ prisma: db, approvalId, adminId, approved });
      socket.emit('agent:decision', { approvalId, status: data.status, decidedBy: data.decidedBy, decidedAt: data.decidedAt });
    } catch (err) {
      const code =
        err && err.code === 'EXPIRED' ? 'APPROVAL_EXPIRED'
        : err && (err.code === 'NOT_FOUND' || err.code === 'NOT_OWNED') ? 'APPROVAL_NOT_FOUND'
        : err && (err.code === 'NOT_PENDING' || err.code === 'REJECTED' || err.code === 'ALREADY_CONSUMED')
          ? 'APPROVAL_ALREADY_DECIDED'
          : 'DECISION_FAILED';
      socket.emit('agent:error', { code, detail: 'could not record the decision' });
    }
  });
}

/**
 * Wire the namespace onto a real HTTP server. Keep this thin: anything here can
 * neither be unit-tested nor reasoned about, so it stays at "create + attach".
 */
function initAgentSocket(httpServer) {
  const { Server } = require('socket.io');
  const { isAllowedOrigin } = require('../../config/cors');

  const io = new Server(httpServer, {
    path: SOCKET_PATH,
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        return isAllowedOrigin(origin) ? callback(null, true) : callback(new Error('ORIGIN_NOT_ALLOWED'), false);
      },
      credentials: true,
      methods: ['GET', 'POST'],
    },
  });

  io.use(authenticateSocket);
  io.on('connection', (socket) => {
    try {
      registerAgentHandlers(socket);
    } catch {
      socket.emit('agent:error', { code: 'HANDLER_FAILED', detail: 'could not start the session' });
      socket.disconnect(true);
    }
  });

  return io;
}

module.exports = {
  SOCKET_PATH,
  authenticateSocket,
  registerAgentHandlers,
  initAgentSocket,
  readAccessToken,
  parseCookieHeader,
};
