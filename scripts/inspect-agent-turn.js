'use strict';
require('dotenv').config();
const { answerQuestion } = require('../src/services/agent/agentService');
const { createAgentGraph } = require('../src/services/agent/graph');
const prisma = require('../src/config/db');

async function test() {
  try {
    const q = 'عايزك تعملي امتحان لاول فيديو موجود في كورس النحو الوحدة الثانيه و تعمله عشر اسئله منها خمسه MCQ و الخمسه الباقيين مقالي و تخلي قابل انه يتصحح بالai';
    console.log('Sending question:', q);
    
    // We will build graph and inspect state
    let capturedGraph;
    const result = await answerQuestion({
      question: q,
      adminId: 1,
      persist: false,
      prisma,
      graphFactory: (opts) => {
        capturedGraph = createAgentGraph(opts);
        return capturedGraph;
      },
      onEvent: (ev) => console.log('EVENT:', JSON.stringify(ev))
    });
    console.log('RESULT:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('THROWN ERROR:', err);
  } finally {
    await prisma.$disconnect();
  }
}
test();
