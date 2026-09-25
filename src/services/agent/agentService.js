'use strict';

/**
 * agentService.js — ONE entry point for an admin question (Phase 3).
 *
 * The order of work IS the design:
 *
 *   1. Kill switch. Disabled means disabled: no fast path, no model, no cost.
 *   2. Deterministic fast path. The 28 recurring questions are answered from the
 *      database with no model involved — instant, free, unable to hallucinate.
 *   3. Only on a DECLINE (unknown / ambiguous / needs a free-text name) does the
 *      graph run. That is where a model earns its cost, and where its output is
 *      grounding-checked against the tool payloads before an admin ever sees it.
 *   4. The turn is persisted (question + answer + operational metadata) and audited.
 *
 * HUMAN APPROVAL: an interactive "approve this action" flow needs Phase 4's socket
 * layer. What exists here is the dangerous half — the SERVER-SIDE binding — so the
 * UI only has to deliver an approval id:
 *   - the approval is looked up and must belong to this admin;
 *   - it is consumed (single-use) ONLY when a tool call matches its exact tool name
 *     AND its exact canonical arguments hash;
 *   - consumption happens inside the tool-context resolver, i.e. at the last moment
 *     before the mutation would run, so no earlier step can spend it by accident.
 * A model can therefore never widen its own authority: the worst it can do is ask.
 */

const config = require('../../config/env');
const { HumanMessage } = require('@langchain/core/messages');
const { answerDeterministic } = require('./engine');
const { createAgentGraph, finalAnswerText, toolCallSummary } = require('./graph');
const { collectAllowed, checkGrounded } = require('./answerGuard');
const { canonicalArgsHash, consumeApproval, getApproval } = require('./approvals');
const conversations = require('./conversationService');
const audit = require('../auditLog');

class AgentServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentServiceError';
    this.code = code;
  }
}

/**
 * Tool results exactly as the model saw them, so the grounding check judges the
 * answer against what the tools returned — not against a re-query that may have
 * moved on since.
 */
function collectToolPayloads(result) {
  const messages = (result && result.messages) || [];
  const payloads = [];
  for (const message of messages) {
    const isTool = message && typeof message.getType === 'function' && message.getType() === 'tool';
    if (!isTool) continue;
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    try {
      payloads.push(JSON.parse(content));
    } catch {
      // Error strings and refusals are still evidence of what the model was told.
      payloads.push(content);
    }
  }
  return payloads;
}

/**
 * Build the per-tool context resolver for one turn.
 *
 * `approved` is granted only for a tool call matching a consumed approval's tool
 * name AND canonical arguments hash. Everything else is refused downstream by
 * tools/_kit.js, so an unapproved action cannot run even if the model insists.
 */
function createApprovalResolver({ prisma, adminId, conversationId, approval }) {
  const used = { approvalId: null, consumedAt: null };

  async function resolveToolContext(args, def) {
    const base = { prisma, adminId, conversationId };
    if (!approval || !def || def.kind !== 'action') return base;

    const matchesTool = approval.toolName === def.name;
    const matchesArgs = approval.argsHash === canonicalArgsHash(def.name, args);
    if (!matchesTool || !matchesArgs) return base;

    try {
      await consumeApproval({ prisma, approvalId: approval.id, adminId, toolName: def.name, args });
      used.approvalId = approval.id;
      used.consumedAt = new Date().toISOString();
      return { ...base, approved: true };
    } catch {
      // Expired, already spent, or decided by someone else: the tool layer refuses
      // and the model is told, which is the honest outcome.
      return base;
    }
  }

  return { resolveToolContext, used };
}

/**
 * Answer one question.
 *
 * Returns { ok: true, source, answer, conversationId, detail } or
 * { ok: false, code, message } for expected failures (disabled, no provider,
 * provider outage, grounding failure). Throwing is reserved for real bugs.
 */
async function answerQuestion({
  question,
  adminId,
  conversationId = null,
  approvalId = null,
  persist = true,
  prisma,
  graphFactory = createAgentGraph,
}) {
  const startedAt = Date.now();
  const db = prisma;
  if (!config.aiAgent.enabled) {
    return { ok: false, code: 'AGENT_DISABLED', message: 'ميزة المساعد الذكي غير مُفعّلة.' };
  }
  if (typeof question !== 'string' || !question.trim()) {
    return { ok: false, code: 'EMPTY_QUESTION', message: 'لم يتم إرسال أي سؤال.' };
  }

  const conversation = await conversations.getOrCreateConversation({ prisma: db, adminId, conversationId });

  // ── Tier 1: deterministic ───────────────────────────────────────────────────
  const deterministic = await answerDeterministic(question, {
    prisma: db,
    adminId,
    conversationId: conversation.id,
  });
  if (deterministic.matched) {
    if (persist) {
      await conversations.recordTurn({
        prisma: db,
        adminId,
        conversationId: conversation.id,
        question,
        answer: deterministic.answer,
        // conversationService whitelists these keys — sending `tier` would be
        // silently dropped, and an empty metadata object would claim otherwise.
        metadata: {
          deterministic: true,
          latencyMs: deterministic.latencyMs,
          toolCalls: deterministic.tool ? [deterministic.tool] : 0,
        },
      });
    }
    return {
      ok: true,
      source: 'deterministic',
      answer: deterministic.answer,
      conversationId: conversation.id,
      detail: {
        intent: deterministic.intent,
        tool: deterministic.tool,
        latencyMs: Date.now() - startedAt,
        declinedReason: null,
      },
    };
  }

  // ── Tier 2: the model ───────────────────────────────────────────────────────
  if (!config.aiAgent.configured) {
    return {
      ok: false,
      code: 'LLM_NOT_CONFIGURED',
      message: 'لا يوجد مزوّد ذكاء اصطناعي مُهيّأ، ولم تتمكن الطبقة السريعة من الإجابة عن هذا السؤال.',
      declinedReason: deterministic.reason,
      conversationId: conversation.id,
    };
  }

  const approval = approvalId ? await getApproval({ prisma: db, approvalId, adminId }) : null;
  const { resolveToolContext, used } = createApprovalResolver({
    prisma: db,
    adminId,
    conversationId: conversation.id,
    approval,
  });
  const { graph } = graphFactory({ resolveToolContext });

  let run;
  try {
    run = await graph.invoke(
      { messages: [new HumanMessage(question)] },
      { configurable: { thread_id: `conv-${conversation.id}` } }
    );
  } catch (err) {
    return {
      ok: false,
      code: err && err.code === 'ALL_PROVIDERS_FAILED' ? 'LLM_UNAVAILABLE' : 'LLM_ERROR',
      message: 'تعذّر الوصول إلى مزوّد الذكاء الاصطناعي. حاول مرة أخرى.',
      declinedReason: deterministic.reason,
      conversationId: conversation.id,
    };
  }

  const answer = finalAnswerText(run);
  if (!answer) {
    // The model ended without prose — e.g. it spent its whole tool budget.
    return {
      ok: false,
      code: run.stopReason === 'MAX_TOOL_CALLS' ? 'TOOL_BUDGET_EXHAUSTED' : 'EMPTY_ANSWER',
      message: 'لم يتمكن المساعد من إنتاج إجابة. جرّب صياغة السؤال بشكل أوضح.',
      declinedReason: deterministic.reason,
      conversationId: conversation.id,
    };
  }

  // ── Grounding: the answer may not contain figures no tool returned ──────────
  const grounding = checkGrounded(answer, collectToolPayloads(run));
  if (!grounding.ok) {
    return {
      ok: false,
      code: 'GROUNDING_FAILED',
      message: 'تم تجاهل الإجابة لأنها تحتوي أرقاماً لا يمكن تتبّعها إلى بيانات المنصة.',
      ungrounded: grounding.ungrounded,
      conversationId: conversation.id,
    };
  }

  const detail = {
    provider: run.provider,
    toolCalls: toolCallSummary(run),
    stopReason: run.stopReason,
    approval: used.approvalId,
    latencyMs: Date.now() - startedAt,
  };

  if (persist) {
    await conversations.recordTurn({
      prisma: db,
      adminId,
      conversationId: conversation.id,
      question,
      answer,
      metadata: {
        llm: true,
        provider: run.provider,
        model: run.provider === 'gemini' ? config.aiAgent.fallbackModel : config.aiAgent.primaryModel,
        toolCalls: detail.toolCalls,
        latencyMs: detail.latencyMs,
      },
    });
  }

  // One audit row per model-answered turn: the deterministic tier is reproducible
  // from the catalogue, a model answer is not.
  await audit.record(
    { user: { id: adminId } },
    {
      action: 'AGENT_TURN',
      targetType: 'AgentConversation',
      targetId: conversation.id,
      metadata: {
        via: 'agent',
        tier: 'llm',
        provider: run.provider,
        toolCalls: detail.toolCalls,
        declinedReason: deterministic.reason,
        grounded: true,
      },
    }
  );

  return { ok: true, source: 'llm', answer, conversationId: conversation.id, detail };
}

module.exports = {
  AgentServiceError,
  answerQuestion,
  collectToolPayloads,
  createApprovalResolver,
  allowedFromPayloads: collectAllowed,
};
