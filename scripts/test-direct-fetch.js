'use strict';
require('dotenv').config();

const config = require('../src/config/env');
const apiKey = config.aiAgent.geminiApiKey;

async function check(m) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Say hi' }] }]
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    console.log(`Model ${m} -> status: ${res.status}`);
    const data = await res.json();
    if (res.status === 200) {
      console.log(`Model ${m} SUCCESS:`, JSON.stringify(data).slice(0, 150));
    } else {
      console.log(`Model ${m} ERROR:`, JSON.stringify(data).slice(0, 200));
    }
  } catch (err) {
    clearTimeout(timer);
    console.log(`Model ${m} EXCEPTION:`, err.name, err.message);
  }
}

async function run() {
  await check('gemini-3.8-flash');
  await check('gemini-3-flash-preview');
  await check('gemini-flash-latest');
  await check('gemini-3.1-flash-lite');
  await check('gemini-3.1-pro-preview');
}

run();
