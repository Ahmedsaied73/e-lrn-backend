'use strict';
require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../src/config/env');

async function testModels() {
  const apiKey = config.aiAgent.geminiApiKey;
  console.log('API Key prefix:', apiKey ? apiKey.slice(0, 8) + '...' : 'none');
  
  // Test listing models via fetch
  try {
    const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const res = await fetch(listUrl);
    console.log('List models HTTP status:', res.status);
    const data = await res.json();
    if (data.models) {
      console.log('Available models count:', data.models.length);
      const names = data.models.map(m => m.name.replace('models/', ''));
      console.log('Models with generateContent:');
      const genModels = data.models
        .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
        .map(m => m.name.replace('models/', ''));
      console.log(genModels);
    } else {
      console.log('List models response:', data);
    }
  } catch (err) {
    console.error('List models failed:', err);
  }

  // Now let's test a simple prompt on a few models
  const candidateModels = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-3.6-flash', 'gemini-3.7-flash'];
  const genAI = new GoogleGenerativeAI(apiKey);
  for (const m of candidateModels) {
    try {
      const model = genAI.getGenerativeModel({ model: m });
      const r = await model.generateContent('Say hello in Egyptian Arabic');
      console.log(`Model ${m} SUCCESS:`, r.response.text().trim());
      break;
    } catch (e) {
      console.log(`Model ${m} FAILED: status=${e.status} message=${e.message.slice(0, 150)}`);
    }
  }
}

testModels();
