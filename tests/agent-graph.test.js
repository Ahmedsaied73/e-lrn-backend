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

