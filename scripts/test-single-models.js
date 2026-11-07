'use strict';
require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../src/config/env');

async function testSingleModel(m) {
  const apiKey = config.aiAgent.geminiApiKey;
  const genAI = new GoogleGenerativeAI(apiKey);
  try {
    const model = genAI.getGenerativeModel({ model: m });
    const r = await model.generateContent('Say hello in Egyptian Arabic');
    console.log(`Model ${m} SUCCESS:`, r.response.text().trim().slice(0, 100));
  } catch (e) {
    console.log(`Model ${m} FAILED: status=${e.status} message=${e.message.slice(0, 200)}`);
  }
}

async function run() {
  await testSingleModel('gemini-3.7-flash');
  await testSingleModel('gemini-3.5-flash');
  await testSingleModel('gemini-3.1-flash-lite');
  await testSingleModel('gemini-3-flash-preview');
}

run();
