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
const { canonicalArgsHash, consumeApproval, getApproval, requestApproval } = require('./approvals');
const conversations = require('./conversationService');
const audit = require('../auditLog');
const { actionDefinitions } = require('./tools');

const ACTION_NAMES = new Set(actionDefinitions.map((d) => d.name));

/**
 * Scan the turn's message history for an action tool call that was refused by
 * the tool layer for lack of human approval (APPROVAL_REQUIRED). Returns
 * { toolName, args } for the first such call, or null.
 */
function findRefusedMutation(result) {
  const messages = (result && result.messages) || [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg && typeof msg.getType === 'function' && msg.getType() === 'tool') {
      const content = String(msg.content || '');
      if (/APPROVAL_REQUIRED|requires human approval|موافقة/i.test(content)) {
        // Find the matching AI message tool_call that triggered this tool result
        for (let j = i - 1; j >= 0; j -= 1) {
          const prev = messages[j];
          const calls = (prev && prev.tool_calls) || [];
          const match = calls.find((c) => c && c.id === msg.tool_call_id);
          if (match && ACTION_NAMES.has(match.name)) {
            return { toolName: match.name, args: match.args || {} };
          }
        }
      }
    }
  }
  return null;
}

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
 * Run one graph turn, emitting live tool lifecycle events when a listener cares.
 *
 * The graph can return either a compiled LangGraph instance or — in tests —
 * a scripted { invoke } stand-in. When the stand-in is used, its messages are
 * the only progress available, so the runner tolerates both `invoke` and
 * `stream` APIs rather than forcing every graph-shaped object to implement both.
 * The caller (answerQuestion) validates the FINAL answer with the grounding
 * guard either way: live events are progress, never content.
 */
async function runAgentTurn(graph, question, conversationId, emit) {
  const input = { messages: [new HumanMessage(question)] };
  const options = { configurable: { thread_id: `conv-${conversationId}` } };

  if (typeof graph.stream === 'function') {
    // streamMode 'values' yields the full state after each step, so the runner
    // holds the whole conversation and can validate the final answer.
    const seenToolCalls = new Set();
    let lastState = null;
    const stream = await graph.stream(input, { ...options, streamMode: 'values' });
    for await (const state of stream) {
      if (!state || !Array.isArray(state.messages)) continue;
      lastState = state;
      for (const message of state.messages) {
        // New AI tool calls → a progress event, deduplicated across snapshots.
        const calls = (message && message.tool_calls) || [];
        for (const call of calls) {
          if (call && call.id && !seenToolCalls.has(call.id)) {
            seenToolCalls.add(call.id);
            emit({ type: 'tool_call', name: call.name, args: call.args });
          }
        }
        // New tool results → a progress event naming the tool and its outcome.
        if (message && typeof message.getType === 'function' && message.getType() === 'tool') {
          const id = `result:${message.tool_call_id}`;
          if (!seenToolCalls.has(id)) {
            seenToolCalls.add(id);
            emit({
              type: 'tool_result',
              name: message.name || null,
              ok: /error|invalid|approval_required|fail/i.test(String(message.content || '')) === false,
            });
          }
        }
      }
    }
    if (lastState) return lastState;
  }

  return graph.invoke(input, options);
}

/**
 * Answer one question.
 *
 * Returns { ok: true, source, answer, conversationId, detail } or
 * { ok: false, code, message } for expected failures (disabled, no provider,
 * provider outage, grounding failure). Throwing is reserved for real bugs.
 *
 * `onEvent` is a progress callback for live surfaces (socket.io): it receives
 * { type: 'thinking' | 'tier' | 'tool_call' | 'tool_result' } objects. It is
 * best-effort by contract — a listener exception never fails an answer, and the
 * events carry progress (tool names, tiers), never secrets or full payloads.
 */
async function answerQuestion({
  question,
  adminId,
  conversationId = null,
  approvalId = null,
  persist = true,
  prisma,
  graphFactory = createAgentGraph,
  onEvent = null,
}) {
  const startedAt = Date.now();
  const db = prisma || require('../../config/db');

  const emit = (event) => {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent(event);
    } catch {
      // A progress listener must never fail an answer.
    }
  };

  if (!config.aiAgent.enabled) {
    return { ok: false, code: 'AGENT_DISABLED', message: 'ميزة المساعد الذكي غير مُفعّلة.' };
  }
  if (typeof question !== 'string' || !question.trim()) {
    return { ok: false, code: 'EMPTY_QUESTION', message: 'لم يتم إرسال أي سؤال.' };
  }

  emit({ type: 'thinking', status: 'started' });

  const conversation = await conversations.getOrCreateConversation({ prisma: db, adminId, conversationId });

  // ── Tier 1: deterministic ───────────────────────────────────────────────────
  const deterministic = await answerDeterministic(question, {
    prisma: db,
    adminId,
    conversationId: conversation.id,
  });
  if (deterministic.matched) {
    emit({ type: 'tier', tier: 'deterministic', intent: deterministic.intent });
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

  // Running the turn with progress: the graph emits tool lifecycle events, but
  // the grounding check still runs on the final answer before anyone sees it —
  // no token is ever shown before it is validated.
  const { graph } = graphFactory({ resolveToolContext });
  emit({ type: 'tier', tier: 'llm', declinedReason: deterministic.reason });

  let run;
  try {
    const turn = await runAgentTurn(graph, question, conversation.id, emit);
    run = turn;
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

  // ── The interactive hinge: a refused mutation becomes an approval REQUEST ───
  // When the model asked for a mutation and the tool layer refused it for lack of
  // approval, a PENDING approval row is created for exactly that tool call, so the
  // admin UI can show an Approve/Reject button. Granting anything here would be
  // wrong — a request records intent, nothing more.
  let approvalRequested = null;
  const refused = findRefusedMutation(run);
  if (refused) {
    try {
      const created = await requestApproval({
        prisma: db,
        adminId,
        conversationId: conversation.id,
        toolName: refused.toolName,
        args: refused.args,
        ttlMs: config.aiAgent.approvalTtlMs,
      });
      approvalRequested = { approvalId: created.id, toolName: refused.toolName, expiresAt: created.expiresAt };
    } catch {
      // Best-effort: an answer without a button is still a correct answer.
    }
  }

  const detail = {
    provider: run.provider,
    toolCalls: toolCallSummary(run),
    stopReason: run.stopReason,
    approval: used.approvalId,
    approvalRequested,
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
