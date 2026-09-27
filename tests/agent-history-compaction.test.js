'use strict';

/**
 * Token cost — the multi-turn history leak.
 *
 * WHY THIS FILE EXISTS: `state.messages` is the durable record (the grounding guard
 * validates the final answer against every tool payload in it), and every one of those
 * payloads was ALSO re-sent to the model on every model call of every turn. With up to
 * 50 fat rows per read, a 5-turn admin conversation re-shipped four turns of raw JSON
 * every time it asked something new. The compaction is a DISPLAY decision: the state is
 * untouched, only the model's view shrinks.
 *
 * These tests pin the three properties that make the cut safe:
 *   1. the newest payload survives (the model needs it to answer the current turn),
 *   2. spent payloads become a one-line stand-in that still names the tool and its row
 *      count, so the model re-queries instead of guessing,
 *   3. nothing else changes — human turns, AI answers, and the tool-call shape (id +
 *      name) all survive, because a provider rejects a tool call whose result vanished.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { AIMessage, HumanMessage, ToolMessage } = require('@langchain/core/messages');
const { compactToolPayloads, KEPT_TOOL_PAYLOADS } = require('../src/services/agent/graph');

/** A realistic fat read payload: 50 rows, the shape these tools really return. */
function fatPayload(rows = 50) {
  return JSON.stringify({
    data: {
      rows: Array.from({ length: rows }, (_, i) => ({
        student: { slug: `stu${String(i).padStart(8, '0')}`, name: `طالب رقم ${i}`, email: `s${i}@example.com` },
        course: { slug: 'crs123abc456', title: 'دورة الفيزياء', grade: 'THIRD_SECONDARY' },
        progress: 12.5 + i,
        lastAccessIso: '2026-09-27T12:00:00.000Z',
      })),
      returned: rows,
      truncated: false,
    },
    meta: { tool: 'inactive_students', asOf: '2026-09-27T12:00:00.000Z', ms: 12, cappedAt: 50 },
  });
}

const toolMessage = (id, name, content) => new ToolMessage({ content, tool_call_id: id, name });

/** A 4-turn conversation: each turn = question, tool call, tool result, answer. */
function conversation(turns = 4) {
  const messages = [];
  for (let t = 0; t < turns; t += 1) {
    messages.push(new HumanMessage(`سؤال ${t}`));
    messages.push(
      new AIMessage({ content: '', tool_calls: [{ name: 'inactive_students', args: {}, id: `call_${t}` }] })
    );
    messages.push(toolMessage(`call_${t}`, 'inactive_students', fatPayload()));
    messages.push(new AIMessage(`إجابة ${t}`));
  }
  return messages;
}

const chars = (messages) => JSON.stringify(messages.map((m) => ({ r: m.getType(), c: m.content }))).length;

test('the newest tool payload is the one the model keeps', () => {
  const view = compactToolPayloads(conversation(3));
  const tools = view.filter((m) => m.getType() === 'tool');
  assert.equal(tools.length, 3, 'no tool result is dropped, only shortened');
  assert.equal(tools[tools.length - 1].content, fatPayload(), 'the payload for the turn in progress is untouched');
});

test('spent payloads become a one-line stand-in that names the tool and its rows', () => {
  const view = compactToolPayloads(conversation(3));
  const spent = view.filter((m) => m.getType() === 'tool').slice(0, -KEPT_TOOL_PAYLOADS);
  assert.equal(spent.length, 2);
  for (const message of spent) {

test('the tool-call shape survives: an AI call still has its result', () => {
  const view = compactToolPayloads(conversation(2));
  for (const message of view) {
    if (message.getType() !== 'tool') continue;
    assert.ok(message.tool_call_id, 'tool_call_id is required by the provider message shape');
    assert.ok(message.name, 'and the tool name');
  }
  // The AIMessages that REQUESTED the calls are untouched, so the pairing holds.
  const aiCalls = view.filter((m) => m.getType() === 'ai' && (m.tool_calls || []).length > 0);
  assert.equal(aiCalls.length, 2, 'the model can still see which calls it made');
});

test('questions and answers are never touched — a follow-up is answered from the ANSWER', () => {
  const history = conversation(3);
  const view = compactToolPayloads(history);
  const texts = (list, type) => list.filter((m) => m.getType() === type).map((m) => m.content);
  assert.deepEqual(texts(view, 'human'), texts(history, 'human'));
  assert.deepEqual(
    view.filter((m) => m.getType() === 'ai' && !m.tool_calls).map((m) => m.content),
    history.filter((m) => m.getType() === 'ai' && !m.tool_calls).map((m) => m.content)
  );
});

test('a single-turn conversation is unchanged (no saving where there is nothing to save)', () => {
  const history = conversation(1);
  assert.equal(chars(compactToolPayloads(history)), chars(history));
});

test('MEASURED: the saving grows with the conversation, and the state is never touched', () => {
  console.log('\n  history compaction — model-input cost (chars/4 = token estimate)');
  for (const turns of [1, 2, 4, 8]) {
    const history = conversation(turns);
    const before = chars(history);
    const after = chars(compactToolPayloads(history));
    console.log(
      `    ${String(turns).padStart(2)} turns: ${String(before).padStart(7)} -> ${String(after).padStart(7)} chars` +
        `  (~${Math.round(before / 4)} -> ~${Math.round(after / 4)} tok, -${Math.round((1 - after / before) * 100)}%)`
    );
    assert.equal(history.filter((m) => m.getType() === 'tool').length, turns, 'state untouched: nothing removed');
  }
  assert.ok(
    chars(compactToolPayloads(conversation(4))) < chars(conversation(4)) * 0.5,
    'a 4-turn conversation must cost less than half after compaction'
  );
});

    assert.ok(message.content.includes('inactive_students'), 'the model still knows which tool ran');
    assert.ok(message.content.includes('50'), 'and how many rows it returned, so it re-queries');
    assert.ok(!message.content.includes('example.com'), 'no payload data survives in the stand-in');
  }
});
