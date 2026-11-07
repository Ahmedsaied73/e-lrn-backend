'use strict';
require('dotenv').config();
const { createAgentGraph } = require('../src/services/agent/graph');
const prisma = require('../src/config/db');
const { HumanMessage } = require('@langchain/core/messages');

async function test() {
  try {
    const q = 'عايزك تعملي امتحان لاول فيديو موجود في كورس النحو الوحدة الثانيه و تعمله عشر اسئله منها خمسه MCQ و الخمسه الباقيين مقالي و تخلي قابل انه يتصحح بالai';
    console.log('Testing turn execution...');
    const built = createAgentGraph({
      resolveToolContext: () => ({ prisma, adminId: 1 })
    });
    const { graph } = built;
    const input = { messages: [new HumanMessage(q)] };
    const options = { configurable: { thread_id: `test-thread-${Date.now()}` } };

    const stream = await graph.stream(input, { ...options, streamMode: 'values' });
    let lastState = null;
    let step = 0;
    for await (const state of stream) {
      step++;
      lastState = state;
      console.log(`\n=== STEP ${step} ===`);
      console.log('toolCalls total:', state.toolCalls);
      console.log('stopReason:', state.stopReason);
      const lastMsg = state.messages[state.messages.length - 1];
      console.log('Last message type:', lastMsg?.getType ? lastMsg.getType() : typeof lastMsg);
      if (lastMsg?.tool_calls?.length) {
        console.log('AI tool calls:', JSON.stringify(lastMsg.tool_calls.map(c => ({ name: c.name, args: c.args })), null, 2));
      }
      if (lastMsg?.getType && lastMsg.getType() === 'tool') {
        console.log(`Tool ${lastMsg.name} result:`, String(lastMsg.content).slice(0, 150));
      }
      if (lastMsg?.getType && lastMsg.getType() === 'ai') {
        console.log('AI message content:', JSON.stringify(lastMsg.content));
      }
    }
  } catch (err) {
    console.error('ERROR IN TURN:', err.name, err.message, err.stack);
  } finally {
    await prisma.$disconnect();
  }
}
test();
