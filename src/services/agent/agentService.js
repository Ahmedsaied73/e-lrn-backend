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
const { randomUUID } = require('node:crypto');
const { HumanMessage, AIMessage } = require('@langchain/core/messages');
const { answerDeterministic } = require('./engine');
const { createAgentGraph, finalAnswerText, toolCallSummary } = require('./graph');
const { collectAllowed, checkGrounded, withGroundingNote } = require('./answerGuard');
const { loadMemoriesForTurn } = require('./memoryService');
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
 * Tool-call arguments the model sent this turn, as plain objects.
 *
 * A number that rode inside a request (a slug, a window, a take, an id) is not
 * invented, so echoing it back is never a fabrication — the guard needs these
 * separately from the results. Structural content stays out: args are tiny and
 * already model-visible, but the exemption is numeric-only by construction (the
 * guard only ever collects canonical numbers).
 */
function collectToolCallArgs(result) {
  const messages = (result && result.messages) || [];
  const args = [];
  for (const message of messages) {
    const calls = (message && message.tool_calls) || [];
    for (const call of calls) {
      if (call && call.args !== undefined && call.args !== null) args.push(call.args);
    }
  }
  return args;
}

/**
 * Build the per-tool context resolver for one turn.
 *
 * The tool layer no longer reads an `approved` flag: plain actions execute on call
 * (attributed to `adminId`) and destructive tools gate on a confirmationToken their
 * own preview issued. An explicit `approvalId` (the older REST/socket decision flow)
 * is still CONSUMED here when it matches the tool call exactly, so a queued decision
 * is never silently left spendable, but it grants nothing by itself anymore.
 *
 * `turnStartedAt` is the server's stamp for THIS turn (handoff C1). It travels with the
 * context so the confirmation gate can refuse a confirmation issued in the same turn as
 * its own preview. It is an ISO string, not a Date: the context crosses the LangChain
 * serialization boundary, where a Date would not survive; tools/_kit.js coerces it back.
 *
 * NOTE: this resolver is invoked once per TOOL CALL, so `turnStartedAt` must be computed
 * once per TURN, outside it (see answerQuestion). A `new Date()` inside the resolver
 * would re-stamp the turn for every call and no confirmation would ever look same-turn.
 */
function createApprovalResolver({ prisma, adminId, conversationId, approval, turnStartedAt }) {
  const used = { approvalId: null, consumedAt: null };
  const base = { prisma, adminId, conversationId, turnStartedAt };

  async function resolveToolContext(args, def) {
    if (!approval || !def || (def.kind !== 'action' && def.kind !== 'confirm')) return base;

    const matchesTool = approval.toolName === def.name;
    const matchesArgs = approval.argsHash === canonicalArgsHash(def.name, args);
    if (!matchesTool || !matchesArgs) return base;

    try {
      await consumeApproval({ prisma, approvalId: approval.id, adminId, toolName: def.name, args });
      used.approvalId = approval.id;
      used.consumedAt = new Date().toISOString();
    } catch {
      // Expired, already spent, or decided by someone else: the tool layer refuses
      // and the model is told, which is the honest outcome.
    }
    return base;
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
async function runAgentTurn(graph, question, conversationId, emit, priorMessages = []) {
  const history = Array.isArray(priorMessages) ? priorMessages : [];
  const input = { messages: [...history, new HumanMessage(question)] };
  const options = { configurable: { thread_id: `conv-${conversationId}-${Date.now()}` } };

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
          if (call && cal‌l.id && !seenToolCalls.has(call.id)) {
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
              // A preview awaiting confirmation is NOT a failure; an error, a
              // typed refusal, or a confirmation-gate miss IS shown as not-ok.
              ok: /error|invalid|approval_required|confirmation_(not_found|mismatch|expired)|fail/i.test(
                String(message.content || ''),
              ) === false,
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
 *
 * `graphFactory` and `answerFactory` are the two test seams: the graph builder, and
 * the deterministic router (needed since Phase 5, because the provider-outage path
 * consults the fast path a second time and a test must be able to count those calls).
 */
async function answerQuestion({
  question,
  adminId,
  conversationId = null,
  approvalId = null,
  persist = true,
  prisma,
  graphFactory = createAgentGraph,
  answerFactory = answerDeterministic,
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

  // ── Phase 4.5: the conversation row is created WITH the turn, not before it ──
  //
  // Creating the row up front is what left message-less conversations in the
  // sidebar whenever a turn failed (a grounding failure or a provider outage left
  // a titless, empty row the admin could neither open nor explain). Now a NEW
  // conversation is not created here at all: the row is written together with its
  // first pair of messages, in ONE round trip, after there is something to store.
  //
  // `pendingId` is what the turn uses until then. It must be UNIQUE and not derived
  // from a constant: the graph's checkpointer is keyed by thread id, so two admins
  // opening their first conversation at the same time would otherwise share one
  // thread and see each other's messages in the model context.
  const continuing = conversationId !== undefined && conversationId !== null;
  const conversation = continuing
    ? await conversations.getOrCreateConversation({ prisma: db, adminId, conversationId })
    : { id: null };
  const turnConversationId = conversation.id === null ? `pending-${randomUUID()}` : conversation.id;

  /**
   * The ONE place that knows how a turn is written.
   *
   * The "is this a new conversation?" branch must not be duplicated per tier: getting
   * it wrong in one tier and not the other is precisely how message-less rows used to
   * reappear. `persist: false` (a caller that only wants the answer) skips the write
   * entirely and leaves conversation.id null.
   */
  async function persistTurn(answer, metadata) {
    if (!persist) return;
    if (conversation.id === null) {
      const created = await conversations.createConversationWithTurn({
        prisma: db,
        adminId,
        question,
        answer,
        metadata,
      });
      conversation.id = created.id;
      return;
    }
    await conversations.recordTurn({
      prisma: db,
      adminId,
      conversationId: conversation.id,
      question,
      answer,
      metadata,
      // The ownership gate already ran at the top of this turn, so recordTurn reuses
      // that row instead of reading it again (~355ms of a ~1.7s follow-up turn). It
      // still re-checks the row against the id and the admin.
      ...(continuing ? { validated: conversation } : {}),
    });
  }

  // ── Tier 1: deterministic ───────────────────────────────────────────────────
  const deterministic = await answerFactory(question, {
    prisma: db,
    adminId,
    conversationId: conversation.id,
  });
  if (deterministic.matched) {
    emit({ type: 'tier', tier: 'deterministic', intent: deterministic.intent });
    await persistTurn(deterministic.answer, {
      // conversationService whitelists these keys — sending `tier` would be
      // silently dropped, and an empty metadata object would claim otherwise.
      deterministic: true,
      latencyMs: deterministic.latencyMs,
      toolCalls: deterministic.tool ? [deterministic.tool] : 0,
    });
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
  // The turn boundary (handoff C1) is stamped HERE — by the server, before the graph is
  // built — so a token issued by this turn's own preview can never be confirmed by this
  // turn. Nothing the model or the question says can influence it.
  const turnStartedAt = new Date().toISOString();
  const { resolveToolContext, used } = createApprovalResolver({
    prisma: db,
    adminId,
    conversationId: conversation.id,
    approval,
    turnStartedAt,
  });

  // Running the turn with progress: the graph emits tool lifecycle events, but
  // the grounding check still runs on the final answer before anyone sees it —
  // no token is ever shown before it is validated.
  //
  // Memory (Phase 7, §3.9): the loader closure below owns this turn's identity
  // (db, admin, what "recent" means). The graph only ever receives a function
  // that returns strings — it cannot ask for another admin's memories because it
  // cannot name them. Injection happens per MODEL CALL, not per turn, so a turn
  // that calls tools three times shows the same labelled block three times; the
  // prompt marks it as remembered facts, never as something just said.
  const built = graphFactory({
    resolveToolContext,
    loadTurnMemories: () => loadMemoriesForTurn({ prisma: db, adminId }),
  });
  const { graph } = built;
  let priorMessages = [];
  if (turnConversationId) {
    try {
      const historyRows = await conversations.loadConversationHistory({
        prisma: db,
        conversationId: turnConversationId,
        limit: 20,
      });
      priorMessages = historyRows.map((row) =>
        row.role === 'USER' ? new HumanMessage(row.content) : new AIMessage(row.content)
      );
    } catch (err) {
      console.warn(`[WARN] agent.history_load_failed ${JSON.stringify({ error: err && err.message })}`);
    }
  }

  let run;
  try {
    const turn = await runAgentTurn(graph, question, turnConversationId, emit, priorMessages);
    run = turn;
  } catch (err) {
    // A provider outage (Decision #17) is handled differently from a real bug: the
    // fast path gets ONE last look (below), and the admin is told plainly what
    // happened. Anything else — a bad key, a malformed request — is a different fact
    // and must not be reported as "the service is down".
    if (!err || err.code !== 'ALL_PROVIDERS_FAILED') {
      return {
        ok: false,
        code: 'LLM_ERROR',
        message: 'حصل خطأ أثناء توليد الرد. جرّب تاني، ولو كررت نفسها راجع إعدادات مزوّد الذكاء الاصطناعي.',
        declinedReason: deterministic.reason,
        conversationId: conversation.id,
      };
    }

    // §3.5 / Decision #17: try the fast-path router against the SAME question before
    // giving up — a single deterministic check, never a retry loop with hidden backoff.
    // In today's tier order the fast path already ran and declined (that is how the turn
    // reached the model at all), so this second look only matters if that order ever
    // changes; its cost is one route() call and its value is that the guarantee stays
    // true without anyone remembering to re-add it.
    const lastChance = await answerFactory(question, {
      prisma: db,
      adminId,
      conversationId: conversation.id,
    });
    if (lastChance.matched) {
      emit({ type: 'tier', tier: 'deterministic', intent: lastChance.intent });
      await persistTurn(lastChance.answer, {
        deterministic: true,
        latencyMs: lastChance.latencyMs,
        toolCalls: lastChance.tool ? [lastChance.tool] : 0,
      });
      return {
        ok: true,
        source: 'deterministic',
        answer: lastChance.answer,
        conversationId: conversation.id,
        detail: {
          intent: lastChance.intent,
          tool: lastChance.tool,
          latencyMs: Date.now() - startedAt,
          declinedReason: deterministic.reason,
        },
      };
    }

    // Nothing left to try: say so, in the admin's own dialect, with the real cause —
    // the model tier is unavailable. No silent retry ever ran behind this answer.
    return {
      ok: false,
      code: 'PROVIDER_UNAVAILABLE',
      message:
        'مزوّد الذكاء الاصطناعي مش مستجيب دلوقتي (ضغط على الخدمة أو مشكلة مؤقتة عنده). جرّب تاني بعد شوية؛ ' +
        'ولو محتاج رقم أو تقرير بسرعة، اسأل عن حاجة من التقارير الجاهزة زي عدد الطلاب أو اشتراكات الشهر.',
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

  // ── Grounding: advisory, never destructive (Phase 4, handoff 3.4) ─────────
  //
  // A figure no tool returned is a warning, not a verdict: the answer is shown,
  // the figures are recorded on the turn, and one short Arabic caveat is
  // appended — once, and only when something was actually flagged. The guard
  // itself evaluates the three exemptions (numbers the admin typed, numbers in
  // this turn's tool-call arguments, a turn in which no tool ran at all), so the
  // worst case for any turn is an answer with a trailing note.
  const grounding = checkGrounded(answer, collectToolPayloads(run), {
    question,
    toolArgs: collectToolCallArgs(run),
  });
  const groundedAnswer = withGroundingNote(answer, grounding);
  const unverifiedFigures = grounding.ungrounded;

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

  // Per-turn measurement (Decision Q3): the weight of the model-facing tool surface this
  // turn bound, and how many model calls it spent. Read from the graph the turn actually
  // used, so the number describes THIS turn rather than a re-derivation of it. A graph
  // double without turnMetrics (an older test seam) reports null instead of failing.
  const turnMetrics =
    typeof built.turnMetrics === 'function' ? built.turnMetrics() : { modelCalls: null, toolSurface: null };

  const detail = {
    provider: run.provider,
    // WHICH model answered, taken from the failover that actually ran rather than
    // re-derived from config (Phase 5): with two attempts on one vendor, a
    // provider-name-only record cannot tell the operator which tier answered.
    model: run.model || null,
    toolCalls: toolCallSummary(run),
    stopReason: run.stopReason,
    approval: used.approvalId,
    approvalRequested,
    modelCalls: turnMetrics.modelCalls,
    toolSurface: turnMetrics.toolSurface,
    latencyMs: Date.now() - startedAt,
    unverifiedFigures,
    // Why Tier 2 ran at all. A `null` here means the turn never needed a reason —
    // only a turn that first heard "no" from Tier 1 gets here.
    declinedReason: deterministic.reason,
  };

  await persistTurn(groundedAnswer, {
    llm: true,
    provider: run.provider,
    // The model that actually answered — the failover wrapper reports it, so this can
    // never disagree with what the provider layer tried (Phase 5).
    model: run.model || null,
    toolCalls: detail.toolCalls,
    latencyMs: detail.latencyMs,
    unverifiedFigures,
  });

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
        // Phase 4: "the turn was flagged" is the fact, not "the turn was clean".
        // An empty list means the guard had nothing to say; a populated one means
        // the answer the admin saw ends with the caveat line.
        unverifiedFigures,
        // Decision Q3: what binding the whole catalogue every turn actually cost, and how
        // many model calls the turn spent. Read from the audit trail, never guessed.
        toolSurface: detail.toolSurface,
        modelCalls: detail.modelCalls,
      },
    }
  );

  return { ok: true, source: 'llm', answer: groundedAnswer, conversationId: conversation.id, detail };
}

module.exports = {
  AgentServiceError,
  answerQuestion,
  collectToolPayloads,
  collectToolCallArgs,
  createApprovalResolver,
  allowedFromPayloads: collectAllowed,
};
