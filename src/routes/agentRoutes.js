'use strict';

/**
 * agentRoutes.js — the agent's REST surface (Phase 4).
 *
 * Mounted ONLY when the agent is enabled (app.js, next to the other optional
 * modules) — disabled means no /admin/agent routes at all, never stubs. Every
 * route requires authenticateToken + authorizeAdmin(), and POST /ask is rate
 * limited per admin because a single call can reach a paid LLM (the same reason
 * the Paymob checkout endpoint is per-user limited).
 *
 * Response envelope: { success, ok, data?, error?, code? } — the repo's
 * { success, error } shape plus an `ok` flag because an assistant turn can fail
 * in ways that are not HTTP errors (a refused model answer, an exhausted tool
 * budget): those return 200 with ok:false rather than a misleading 5xx.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticateToken, authorizeAdmin } = require('../middlewares/index');
const { createRateLimitStore } = require('../integrations/redis/rateLimitStore');
const { isRedisEnabled } = require('../integrations/redis/redisClient');
const config = require('../config/env');
const prisma = require('../config/db');
const { AppError } = require('../utils/AppError');
const { answerQuestion } = require('../services/agent/agentService');
const { listConversations, getMessages } = require('../services/agent/conversationService');
const {
  decideApproval,
  getApproval,
  AgentApprovalError,
} = require('../services/agent/approvals');

const router = express.Router();

// All agent routes are admin-only. authenticateToken first (it populates req.user),
// then the role guard — the same order as every other /admin/* route.
router.use(authenticateToken, authorizeAdmin());

// Per-admin ask budget. Large enough that no real admin workflow hits it, small
// enough that a stuck client cannot burn the provider quota unattended. Mounted
// AFTER the auth middlewares so the key is the admin id, not a shared IP.
const askLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.AI_AGENT_ASK_LIMIT) || 60,
  message: 'Too many agent requests, please wait a moment.',
  keyGenerator: (req) => (req.user && req.user.id ? `u:${req.user.id}` : `ip:${req.ip}`),
  ...(isRedisEnabled() ? { store: createRateLimitStore('rl:agent-ask:', { failClosed: config.rateLimit.requireRedis }) } : {}),
});

function positiveIntOrNull(value, field) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new AppError(`${field} must be a positive integer`, 400, 'AGENT_INVALID_INPUT');
  }
  return n;
}

// ── POST /admin/agent/ask ─────────────────────────────────────────────────────
// The one turn endpoint: { question, conversationId?, approvalId? } in,
// { ok, source, answer, conversationId, detail } out. An approvalId lets the
// model spend a previously granted, owner-checked approval exactly once.
router.post('/ask', askLimiter, async (req, res, next) => {
  try {
    const { question, conversationId = null, approvalId = null } = req.body || {};
    if (typeof question !== 'string' || question.trim().length === 0) {
      throw new AppError('question is required', 400, 'AGENT_QUESTION_REQUIRED');
    }
    if (question.length > 2000) {
      throw new AppError('question is too long (max 2000 characters)', 400, 'AGENT_QUESTION_TOO_LONG');
    }
    const conversationIdOrNull = positiveIntOrNull(conversationId, 'conversationId');
    const approvalIdOrNull = positiveIntOrNull(approvalId, 'approvalId');

    const result = await answerQuestion({
      question,
      adminId: req.user.id,
      conversationId: conversationIdOrNull,
      approvalId: approvalIdOrNull,
      prisma,
    });

    // Business-level turns (refused answers, exhausted budgets, provider outages)
    // are honest answers, not server errors — they ride a 200 with ok:false, so a
    // dashboard cannot mistake them for a broken endpoint.
    if (!result.ok) {
      const status = result.code === 'AGENT_DISABLED' ? 503 : 200;
      return res.status(status).json({
        success: true,
        ok: false,
        code: result.code,
        message: result.message,
        conversationId: result.conversationId || null,
        declinedReason: result.declinedReason || null,
        ungrounded: result.ungrounded || null,
      });
    }

    return res.json({
      success: true,
      ok: true,
      answer: result.answer,
      source: result.source,
      conversationId: result.conversationId,
      detail: result.detail,
    });
  } catch (err) {
    return next(err);
  }
});

// ── GET /admin/agent/conversations ────────────────────────────────────────────
router.get('/conversations', async (req, res, next) => {
  try {
    const take = req.query && req.query.take !== undefined ? Number(req.query.take) : 30;
    const data = await listConversations({ prisma, adminId: req.user.id, take });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// ── GET /admin/agent/conversations/:id/messages ───────────────────────────────
router.get('/conversations/:id/messages', async (req, res, next) => {
  try {
    const conversationId = Number(req.params.id);
    if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
      throw new AppError('conversation id must be a positive integer', 400, 'AGENT_INVALID_INPUT');
    }
    const data = await getMessages({ prisma, adminId: req.user.id, conversationId });
    return res.json({ success: true, data });
  } catch (err) {
    if (err && err.name === 'AgentConversationError' && err.code === 'NOT_OWNED') {
      return next(new AppError('conversation not found', 404, 'AGENT_CONVERSATION_NOT_FOUND'));
    }
    return next(err);
  }
});

// ── POST /admin/agent/approvals/:id/decide ────────────────────────────────────
// The human half of the interrupt: { approved: true|false } on an approval the
// admin owns. Deciding is idempotent in outcome but not in history — a second
// decision on a non-pending row is refused rather than silently accepted.
router.post('/approvals/:id/decide', async (req, res, next) => {
  try {
    const approvalId = Number(req.params.id);
    if (!Number.isSafeInteger(approvalId) || approvalId <= 0) {
      throw new AppError('approval id must be a positive integer', 400, 'AGENT_INVALID_INPUT');
    }
    const approved = req.body && req.body.approved;
    if (approved !== true && approved !== false) {
      throw new AppError('approved must be true or false', 400, 'AGENT_INVALID_INPUT');
    }
    const data = await decideApproval({ prisma, approvalId, adminId: req.user.id, approved });
    return res.json({ success: true, data });
  } catch (err) {
    if (err instanceof AgentApprovalError) {
      const status = err.code === 'NOT_FOUND' || err.code === 'NOT_OWNED' ? 404 : 409;
      return next(new AppError(err.message, status, `AGENT_APPROVAL_${err.code}`));
    }
    return next(err);
  }
});

// ── GET /admin/agent/approvals/:id ────────────────────────────────────────────
router.get('/approvals/:id', async (req, res, next) => {
  try {
    const approvalId = Number(req.params.id);
    if (!Number.isSafeInteger(approvalId) || approvalId <= 0) {
      throw new AppError('approval id must be a positive integer', 400, 'AGENT_INVALID_INPUT');
    }
    const data = await getApproval({ prisma, approvalId, adminId: req.user.id });
    if (!data) return next(new AppError('approval not found', 404, 'AGENT_APPROVAL_NOT_FOUND'));
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// ── POST /admin/agent/approvals ───────────────────────────────────────────────
// Create an approval request directly: { toolName, args, conversationId?, ttlMs? }.
// The primary source of these rows is the agent itself (a refused mutation becomes
// a pending request), but exposing the creation endpoint makes the flow testable
// and lets a dashboard retry a request that expired before it was decided.
router.post('/approvals', async (req, res, next) => {
  try {
    const { toolName, args, conversationId = null, ttlMs = null } = req.body || {};
    const conversationIdOrNull = positiveIntOrNull(conversationId, 'conversationId');
    const data = await requestApproval({
      prisma,
      adminId: req.user.id,
      conversationId: conversationIdOrNull,
      toolName,
      args,
      ...(ttlMs === null || ttlMs === undefined ? {} : { ttlMs: Number(ttlMs) }),
    });
    return res.status(201).json({
      success: true,
      data: { id: data.id, toolName: data.toolName, argsHash: data.argsHash, status: data.status, expiresAt: data.expiresAt },
    });
  } catch (err) {
    if (err instanceof AgentApprovalError) {
      return next(new AppError(err.message, 400, `AGENT_APPROVAL_${err.code}`));
    }
    return next(err);
  }
});

module.exports = router;
