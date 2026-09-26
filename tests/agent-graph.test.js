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
const { toolNames: allToolNames } = require('../src/services/agent/tools');
const { createAgentGraph, finalAnswerText, toolCallSummary, countToolCalls } = require('../src/services/agent/graph');

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

test('the model cannot mutate anything by asking: no approval, no action', async () => {
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
    // The resolver deliberately grants NOTHING: this is an unapproved request.
    const { graph, hasMutatingTools } = createAgentGraph({
      resolveToolContext: () => ({ prisma, adminId: 1 }),
      invokeModel: model.invokeModel,
    });
    assert.equal(hasMutatingTools, true);

    const result = await graph.invoke(
      { messages: [new HumanMessage('علّم الاشتراك كمدفوع')] },
      { configurable: { thread_id: threadId('no-approval') } }
    );

    const toolMessages = result.messages.filter((m) => typeof m.getType === 'function' && m.getType() === 'tool');
    assert.equal(toolMessages.length, 1);
    // The tool layer refused, and the refusal is what the model sees.
    assert.match(String(toolMessages[0].content), /APPROVAL_REQUIRED|موافقة|requires human approval/i);
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
 * Phase 4.5 — the tool SURFACE the model is shown.
 *
 * Binding all 28 read tools shipped ~7k tokens of schema per call against an 8k
 * tokens/minute free tier, so the agentic tier was structurally unable to answer
 * anything. The trim is what makes it work — and these tests exist because a silent
 * re-fattening would not fail anything else: the tier would just start 413ing again
 * in production while every other suite stayed green.
 */
test('the model is shown a SHORT tool surface, not the whole catalogue', async () => {
  const model = scriptedModel([textAnswer('لا حاجة لأداة.')]);
  const { graph, toolNames } = createAgentGraph({ resolveToolContext: ctx, invokeModel: model.invokeModel });

  await graph.invoke(
    { messages: [new HumanMessage('نظرة عامة')] },
    { configurable: { thread_id: threadId('trim') } }
  );

  const bound = model.calls[0].toolNames;
  assert.ok(
    bound.length < toolNames.length,
    `the surface was not trimmed at all: ${bound.length} of ${toolNames.length}`
  );
  assert.ok(bound.length <= 8, `the surface must stay small, got ${bound.length}: ${bound.join(', ')}`);
  assert.ok(bound.includes('platform_overview'), 'the core tool must be on the surface');
  assert.equal(model.calls[0].toolNames.join(','), bound.join(','), 'the surface must be stable within a turn');
});

test('a tool the question names is exposed even though it is not core', async () => {
  const model = scriptedModel([
    toolCall('payment_issues', { windowDays: 30 }, 'call_pay'),
    textAnswer('لا توجد مشاكل دفع.'),
  ]);
  const { graph, selectFor } = createAgentGraph({ resolveToolContext: ctx, invokeModel: model.invokeModel });

  const result = await graph.invoke(
    { messages: [new HumanMessage('مشاكل الدفع')] },
    { configurable: { thread_id: threadId('surface') } }
  );

  assert.ok(
    model.calls[0].toolNames.includes('payment_issues'),
    `the model must be shown the tool the question is about, got: ${model.calls[0].toolNames.join(', ')}`
  );
  assert.deepEqual(toolCallSummary(result), ['payment_issues'], 'and it must actually run');
  // WHY it was on the surface matters as much as that it was: 'router' (the fast
  // path would have chosen it) or a lexical score both mean "chosen for THIS
  // question", whereas 'core' would mean it was only there by accident.
  assert.notEqual(
    selectFor('مشاكل الدفع').reasons.payment_issues,
    'core',
    'payment_issues must be selected because the question is about it'
  );
});

test('trimming the surface does not shrink the execution authority', async () => {
  // The shortlist is a DISPLAY decision; the ToolNode still holds the full
  // catalogue, so the guards (row caps, redaction, the approval gate) apply to
  // every tool exactly as before. If this ever fails, the surface has started
  // deciding what is executable — which would make a prompt an authority.
  const model = scriptedModel([
    toolCall('admin_audit_recent', { windowDays: 7 }, 'call_audit'),
    textAnswer('تم.'),
  ]);
  const { graph, selectFor } = createAgentGraph({ resolveToolContext: ctx, invokeModel: model.invokeModel });

  const exposed = selectFor('مرحبا').names;
  assert.equal(
    exposed.includes('admin_audit_recent'),
    false,
    'precondition: this tool is NOT on the surface for an unrelated question'
  );

  const result = await graph.invoke(
    { messages: [new HumanMessage('مرحبا')] },
    { configurable: { thread_id: threadId('authority') } }
  );
  assert.deepEqual(toolCallSummary(result), ['admin_audit_recent'], 'the tool node still executes it');
});

