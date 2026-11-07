'use strict';
require('dotenv').config();

const config = require('../src/config/env');
const { listDefinitions, toLangChainTools } = require('../src/services/agent/tools');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const prisma = require('../src/config/db');

async function testWithTools(modelName) {
  console.log(`\n--- Testing model ${modelName} with tools ---`);
  const apiKey = config.aiAgent.geminiApiKey;
  const defs = listDefinitions({ includeActions: true });
  const boundTools = toLangChainTools(defs, () => ({ prisma, adminId: 1 }));
  
  const chatModel = new ChatGoogleGenerativeAI({
    apiKey,
    model: modelName,
    temperature: 0,
    maxRetries: 0,
  });

  const bound = chatModel.bindTools(boundTools);
  try {
    const res = await bound.invoke([
      { role: 'user', content: 'عايزك تعملي امتحان لاول فيديو موجود في كورس النحو الوحدة الثانيه و تعمله عشر اسئله منها خمسه MCQ و الخمسه الباقيين مقالي و تخلي قابل انه يتصحح بالai' }
    ]);
    console.log(`Model ${modelName} with tools SUCCESS:`);
    console.log('Tool calls:', JSON.stringify(res.tool_calls, null, 2));
    return true;
  } catch (err) {
    console.log(`Model ${modelName} with tools FAILED:`);
    console.log('status:', err.status);
    console.log('message:', err.message);
    return false;
  }
}

testWithTools('gemini-3.1-flash-lite').finally(() => prisma.$disconnect());
