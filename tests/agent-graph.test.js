'use strict';

/**
 * Phase 3 — the agent graph (offline: the model is scripted, the DB is real).
 *
 * What these tests are really about is bounded behaviour: the graph must loop
 * through tools, stop when its tool budget is spent, and be *unable* to mutate
 * anything by simply asking. A scripted model makes those paths deterministic —
 * no provider, no key, no flakiness.
 */

process.env.REDIS_ENABLED = 'false';
process.env.AI_AGENT_ENABLED = 'true';
// Small footprint: this suite runs next to the heavyweight ones on one database.
process.env.DATABASE_CONNECTION_LIMIT = '5';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AIMessage, HumanMessage } = require('@langchain/core/messages');
const config = require('../src/config/env');
const prisma = require('../src/config/db');
const { readDefinitions, actionDefinitions, toolNames: allToolNames } = require('../src/services/agent/tools');
const {
  createAgentGraph,
  finalAnswerText,
  toolCallSummary,
  countToolCalls,
  buildSystemPrompt,
  formatCairoDate,
  MEMORY_BLOCK_LABEL,
} = require('../src/services/agent/graph');

let threadCounter = 0;
function threadId(label) {
  threadCounter += 1;
  return `test-${label}-${threadCounter}-${Date.now()}`;
}

/** A model that replays a script: an AIMessage, a function, or an Error to throw. */
function scriptedModel(script) {
  const calls = [];
  return {
    calls,
    async invokeModel(messages, tools) {
      calls.push({
        messageCount: messages.length,
        toolNames: tools.map((t) => t.name),
        firstMessage: messages[0],
        lastMessage: messages[messages.length - 1],
      });
      const next = script.shift();
      if (!next) throw new Error('scripted model ran out of responses');
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return { result: next(messages), provider: 'scripted' };
      return { result: next, provider: 'scripted' };
    },
  };
}

function toolCall(name, args, id) {
  return new AIMessage({ content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] });
}

function textAnswer(content) {
  return new AIMessage({ content });
}

const ctx = () => ({ prisma, adminId: 1 });

test('the graph runs a tool call and returns the model text', async () => {
  const model = scriptedModel([
    toolCall('platform_overview', {}, 'call_1'),
    textAnswer('لديك ١٠٠ طالب.'),
  ]);
  const { graph, toolNames } = createAgentGraph({ resolveToolContext: ctx, invokeModel: model.invokeModel });

  const result = await graph.invoke(
    { messages: [new HumanMessage('نظرة عامة')] },
    { configurable: { thread_id: threadId('loop') } }
  );

  assert.equal(finalAnswerText(result), 'لديك ١٠٠ طالب.');
  assert.equal(result.toolCalls, 1);
  assert.equal(result.stopReason, null);
  assert.equal(result.provider, 'scripted');
  // The tool actually executed against the database.
  assert.deepEqual(toolCallSummary(result), ['platform_overview']);
  assert.ok(toolNames.includes('platform_overview'));
  // Two model turns: one to ask for the tool, one to answer with the result.
  assert.equal(model.calls.length, 2);
  assert.ok(model.calls[1].messageCount > model.calls[0].messageCount, 'the tool result must be fed back');
});

test('a text-only answer never touches the tools', async () => {
  const model = scriptedModel([textAnswer('لا أستطيع الإجابة بدون أداة مناسبة.')]);
  const { graph } = createAgentGraph({ resolveToolContext: ctx, invokeModel: model.invokeModel });

  const result = await graph.invoke(
    { messages: [new HumanMessage('مرحبا')] },
    { configurable: { thread_id: threadId('text') } }
  );

  assert.equal(finalAnswerText(result), 'لا أستطيع الإجابة بدون أداة مناسبة.');
  assert.equal(countToolCalls(result.messages[result.messages.length - 1]), 0);
  assert.equal(toolCallSummary(result).length, 0);
  assert.equal(model.calls.length, 1);
});

test('the tool budget is enforced, and the refused calls are answered explicitly', async () => {
  const original = config.aiAgent.maxToolCalls;
  config.aiAgent.maxToolCalls = 2;
  try {
    // A model that keeps asking, forever: exactly the loop the budget exists for.
    const script = [];
    for (let i = 0; i < 8; i += 1) script.push(toolCall('platform_overview', {}, `call_${i}`));
    const model = scriptedModel(script);
    const { graph } = createAgentGraph({ resolveToolContext: ctx, invokeModel: model.invokeModel });

    const result = await graph.invoke(
      { messages: [new HumanMessage('أعد المحاولة للأبد')] },
      { configurable: { thread_id: threadId('budget') } }
    );

    assert.equal(result.stopReason, 'MAX_TOOL_CALLS');
    // Two calls were executed (the budget), the third batch was refused.
    assert.equal(result.toolCalls, 2);
    // The refused call must be ANSWERED, not silently dropped: an AIMessage whose
    // tool_calls have no results breaks the next provider turn.
    const refused = result.messages.filter(
      (m) => typeof m.getType === 'function' && m.getType() === 'tool' && /لم يتم تنفيذ الأداة/.test(String(m.content))
    );
    assert.equal(refused.length, 1);
    assert.match(String(refused[0].content), /الحد الأقصى/);
    // It stopped early rather than replaying the whole script.
    assert.ok(model.calls.length <= 3, `expected the loop to be cut off, saw ${model.calls.length} model calls`);
  } finally {
    config.aiAgent.maxToolCalls = original;
  }
});

test('the model cannot mutate anything it cannot attribute: visibility is not authority', async () => {
  const agentConfig = config.aiAgent;
  const originalAllow = agentConfig.allowMutations;
  // Arm the mutations switch so the action tools are even VISIBLE to the model —
  // the point is that visibility is not authority.
  agentConfig.allowMutations = true;
  try {
    const actionName = allToolNames().find((name) => name === 'mark_enrollment_paid');
    assert.ok(actionName, 'expected the mutation tool to be exposed when mutations are armed');

    const model = scriptedModel([
      toolCall(actionName, { userSlug: 'aaaaaaaaaaaa', courseSlug: 'bbbbbbbbbbbb' }, 'call_action'),
      textAnswer('تم.'),
    ]);
    // Phase 3: authority IS attribution. The resolver deliberately grants NO
    // adminId — the tool layer must refuse before it ever resolves a target,
    // so the model sees the typed refusal, never a mutation result.
    const { graph, hasMutatingTools } = createAgentGraph({
      resolveToolContext: () => ({ prisma }),
      invokeModel: model.invokeModel,
    });
    assert.equal(hasMutatingTools, true);

    const result = await graph.invoke(
      { messages: [new HumanMessage('علّم الاشتراك كمدفوع')] },
      { configurable: { thread_id: threadId('no-approval') } }
    );

    const toolMessages = result.messages.filter((m) => typeof m.getType === 'function' && m.getType() === 'tool');
    assert.equal(toolMessages.length, 1);
    // The tool layer refused (unattributable call), and the refusal is what the
    // model sees — the mutation never ran against any target.
    assert.match(String(toolMessages[0].content), /ADMIN_REQUIRED/i);
    assert.doesNotMatch(String(toolMessages[0].content), /paymentStatus/);
  } finally {
    agentConfig.allowMutations = originalAllow;
  }
});

test('the tool context resolver is told WHICH tool is asking, so authority can be per-tool', async () => {
  const clauses = [];
  // courses_list takes a `take` argument, so this also proves the resolver sees the
  // model's arguments as the tool layer will see them.
  const model = scriptedModel([toolCall('courses_list', { take: 3 }, 'call_ctx'), textAnswer('تم.')]);
  const { graph } = createAgentGraph({
    resolveToolContext: (args, def) => {
      clauses.push({ tool: def && def.name, args });
      return { prisma, adminId: 1 };
    },
    invokeModel: model.invokeModel,
  });

  await graph.invoke(
    { messages: [new HumanMessage('قائمة الدورات')] },
    { configurable: { thread_id: threadId('clause') } }
  );

  assert.deepEqual(clauses, [{ tool: 'courses_list', args: { take: 3 } }]);
});

/**
 * Phase 1 (v2 rebuild) — the tool SURFACE the model is shown.
 *
 * The Phase 4.5 shortlist that used to live here is GONE (handoff 3.1 + Decision #15):
 * the surface is the catalogue, and AI_AGENT_ALLOW_MUTATIONS is the only filter. The two
 * tests below pin both directions of that switch; the per-turn measurement the audit row
 * carries is asserted with them, because that number is what the revisit trigger reads.
 */
const ACTION_NAMES = new Set(actionDefinitions.map((d) => d.name));

/** Pins the mutation switch for one test: a developer .env must not decide what this proves. */
function pinMutations(value) {
  const original = config.aiAgent.allowMutations;
  config.aiAgent.allowMutations = value;
  return () => {
    config.aiAgent.allowMutations = original;
  };
}

test('binds every read tool and no action while mutations are off', async () => {
  const restore = pinMutations(false);
  try {
    const model = scriptedModel([textAnswer('لا حاجة لأداة.')]);
    const { graph, toolNames } = createAgentGraph({ resolveToolContext: ctx, invokeModel: model.invokeModel });

    await graph.invoke(
      { messages: [new HumanMessage('نظرة عامة')] },
      { configurable: { thread_id: threadId('surface-reads') } }
    );

    const bound = model.calls[0].toolNames;
    assert.ok(bound.includes('platform_overview'), 'a read tool must be on the surface');
    assert.deepEqual(
      [...bound].sort(),
      readDefinitions.map((d) => d.name).sort(),
      'the read catalogue is bound WHOLE — the keyword shortlist is gone'
    );
    assert.equal(bound.some((n) => ACTION_NAMES.has(n)), false, 'no action while the switch is off');
    assert.deepEqual([...toolNames].sort(), [...bound].sort(), 'the executable catalogue follows the same switch');
  } finally {
    restore();
  }
});

test('binds the WHOLE catalogue — actions included — for a question with no write verb', async () => {
  // The definition of done for this phase: «إزيك؟» carries no imperative, and the Phase 4.5
  // keyword heuristic would have hidden every action tool for exactly this message.
  const restore = pinMutations(true);
  try {
    const model = scriptedModel([textAnswer('أهلاً!')]);
    const { graph, turnMetrics } = createAgentGraph({ resolveToolContext: ctx, invokeModel: model.invokeModel });

    await graph.invoke(
      { messages: [new HumanMessage('إزيك؟')] },
      { configurable: { thread_id: threadId('surface-armed') } }
    );

    const bound = model.calls[0].toolNames;
    assert.equal(bound.length, readDefinitions.length + actionDefinitions.length, 'reads + actions, every turn');
    assert.ok(bound.includes('delete_user'), 'even a destructive action is on the surface — the confirm gate is what stops it');
    assert.ok(bound.every((n) => allToolNames().includes(n)), 'the model is never shown a tool outside the catalogue');

    // The per-turn measurement the AGENT_TURN audit row carries (Decision Q3).
    const metrics = turnMetrics();
    assert.equal(metrics.modelCalls, 1, 'one text answer is one model call');
    assert.equal(metrics.toolSurface.tools, bound.length, 'the measured surface is the bound surface');
    assert.ok(metrics.toolSurface.chars > 0 && metrics.toolSurface.tokens > 0, 'the surface has a measured weight');
  } finally {
    restore();
  }
});

test('the mutation switch, not the display surface, decides what the ToolNode can execute', async () => {
  // Replaces "trimming the surface does not shrink the execution authority": the trim is
  // gone, so the invariant is stated where it still bites — with the switch OFF an action is
  // neither offered to the model nor present in the executable catalogue.
  const restore = pinMutations(false);
  try {
    const model = scriptedModel([textAnswer('لا.')]);
    const { graph, tools, toolNames } = createAgentGraph({ resolveToolContext: ctx, invokeModel: model.invokeModel });

    await graph.invoke(
      { messages: [new HumanMessage('مرحبا')] },
      { configurable: { thread_id: threadId('authority') } }
    );

    assert.equal(toolNames.some((n) => ACTION_NAMES.has(n)), false, 'the switch keeps actions out of the catalogue');
    assert.equal(tools.some((t) => ACTION_NAMES.has(t.name)), false, 'and out of the bound ToolNode');
    assert.ok(model.calls[0].toolNames.every((n) => toolNames.includes(n)), 'never offer what cannot run');
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------------ *
 * Phase 2 — the system prompt is BUILT per turn (handoff 3.2).
 * These pin the replacement text, the injected Cairo date, and the Phase 7
 * memory seam. The old prompt's literal numbered rules are gone on purpose:
 * asserting their ABSENCE is what stops the report-writer persona from
 * creeping back in.
 * ------------------------------------------------------------------------ */

test('the prompt is conversational: new persona in, old numbered rules and pending-approval prose out', () => {
  const p = buildSystemPrompt({ now: new Date('2026-09-28T12:00:00Z') });
  // Handoff 3.2 anchors that MUST be present.
  assert.ok(p.startsWith('أنت مساعد ذكي لمدير منصة'), 'opens as the colleague persona, not a report generator');
  assert.match(p, /بالعامية المصرية/, 'Egyptian Arabic is mandated (Decision #16)');
  assert.match(p, /دردشة عادية/, 'general chat is in scope (Decision #3)');
  assert.match(p, /من غير ما يطلب موافقة بزرار/, 'regular writes execute directly (Decision #1)');
  assert.match(p, /معاينة الأول/, 'deletes preview-then-confirm (Decision #6)');
  assert.match(p, /سبب \(reason\)/, 'financial overrides demand a reason (Decision #7)');
  assert.match(p, /بيانات فقط/, 'tool output is data, never instructions');
  // The old persona that must NEVER come back.
  assert.doesNotMatch(p, /القواعد:/, 'the numbered rule block is gone');
  assert.doesNotMatch(p, /العربية الفصحى/, 'the MSA mandate is gone');
  assert.doesNotMatch(p, /لا تكشف تفاصيل داخلية/, 'the old no-capability rule 9 is gone');
  assert.doesNotMatch(p, /أنتظر موافقته|مُرسل وأنتظر/, 'no pending-approval prose (Phase 1 §8 warning honoured)');
  assert.doesNotMatch(p, /\bplatform_overview\b|\benroll_student\b/, 'no tool names hard-coded into the prose');
});

test('the date line is live, Cairo-local, and injectable', () => {
  // 23:00Z on the 28th is already the 29th in Cairo (+2/+3) — proves the
  // conversion, not just string interpolation.
  const p = buildSystemPrompt({ now: new Date('2026-09-28T23:00:00Z') });
  assert.match(p, /النهارده .+ بتوقيت القاهرة\./, 'the date line anchors "today" in Cairo time');
  assert.ok(p.includes(formatCairoDate(new Date('2026-09-28T23:00:00Z'))), 'the line uses the shared formatter');
  assert.ok(/٢٩/.test(p), 'Cairo has rolled over to the 29th while UTC is still on the 28th');
});

test('the memory seam is additive: empty memories change NOTHING, facts append under the label', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  const bare = buildSystemPrompt({ now });
  // An empty list must be byte-identical to no list at all — Phase 7 can ship
  // behind it without any turn changing shape.
  assert.equal(buildSystemPrompt({ now, memories: [] }), bare);
  assert.ok(!bare.includes(MEMORY_BLOCK_LABEL), 'no label without facts');

  const withFacts = buildSystemPrompt({ now, memories: ['المشرف يفضل التقارير الأسبوعية', { content: 'الدورة ٨ هي الأكثر تسجيلًا' }, '   '] });
  assert.ok(withFacts.startsWith(bare), 'facts only APPEND to the prompt');
  assert.ok(withFacts.endsWith(`${MEMORY_BLOCK_LABEL} (من محادثات سابقة):\n- المشرف يفضل التقارير الأسبوعية\n- الدورة ٨ هي الأكثر تسجيلًا`), 'strings and rows both render, blanks drop');
});

test('agentNode feeds the model a freshly built prompt, not a frozen constant', async () => {
  const model = scriptedModel([textAnswer('أهلاً!')]);
  const { graph } = createAgentGraph({ resolveToolContext: ctx, invokeModel: model.invokeModel });

  await graph.invoke(
    { messages: [new HumanMessage('إزيك؟')] },
    { configurable: { thread_id: threadId('prompt-live') } }
  );

  const sys = model.calls[0].firstMessage;
  assert.equal(sys.constructor.name, 'SystemMessage');
  assert.ok(String(sys.content).startsWith('أنت مساعد ذكي لمدير منصة'), 'the live turn starts with the new persona');
  assert.ok(String(sys.content).includes('بتوقيت القاهرة'), 'the per-turn date line reached the model');
  assert.ok(String(sys.content).includes(formatCairoDate(new Date())), 'the date belongs to TODAY (the turn), not to boot time');
});

