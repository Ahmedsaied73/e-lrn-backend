'use strict';

/**
 * provider.js — model access behind a two-method interface.
 *
 *   provider.grade({ system, user }) -> Promise<unknown>
 *
 * The resolved value is RAW (untrusted) model output — validation happens in
 * schemas.js, timeouts/retries in index.js. Swapping models means adding one
 * factory here; nothing else in the codebase names a model or an SDK.
 */

function createGeminiProvider({ apiKey, model }) {
  if (!apiKey) {
    throw new Error('Gemini API key is required');
  }
  // Lazy require: importing LangChain at module load would couple every
  // consumer (including unit checks) to the SDK.
  const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
  const chat = new ChatGoogleGenerativeAI({
    apiKey,
    model,
    temperature: 0, // deterministic grading, not creative writing
  });
  return {
    name: `gemini:${model}`,
    async grade({ system, user }) {
      const res = await chat.invoke([
        ['system', system],
        ['human', user],
      ]);
      const text = typeof res.content === 'string'
        ? res.content
        : JSON.stringify(res.content);
      return JSON.parse(extractJson(text));
    },
  };
}

/**
 * Pull the first {...} block out of model chatter. LLMs are asked for
 * JSON-only, but fences and preamble happen — this keeps one recoverable
 * shape instead of failing on formatting.
 */
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Model output contains no JSON object');
  }
  return text.slice(start, end + 1);
}

/**
 * Deterministic stand-in for checks and offline development. Feed it a queue
 * of verdicts (or Errors to simulate transport/model failures).
 */
function createMockProvider(script = []) {
  const queue = [...script];
  let calls = 0;
  return {
    name: 'mock',
    get calls() {
      return calls;
    },
    async grade() {
      calls += 1;
      if (queue.length === 0) {
        throw new Error('Mock provider script exhausted');
      }
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

module.exports = {
  createGeminiProvider,
  createMockProvider,
  extractJson,
};
