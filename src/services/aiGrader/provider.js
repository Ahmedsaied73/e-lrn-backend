'use strict';

/**
 * provider.js — model access behind a two-method interface.
 *
 * FR-11: Uses LangChain withStructuredOutput(schema) so Gemini returns a
 * typed object directly without fragile extractJson() regex/braces parsing.
 * Also captures usage_metadata (tokensIn, tokensOut) for FR-5/FR-25.
 */

const { RawVerdictSchema, StructuredVerdictSchema } = require('./schemas');

function createGeminiProvider({ apiKey, model }) {
  if (!apiKey) {
    throw new Error('Gemini API key is required');
  }
  const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
  const chat = new ChatGoogleGenerativeAI({
    apiKey,
    model,
    temperature: 0,
  });

  return {
    name: `gemini:${model}`,
    async grade({ system, user, structured }, { signal } = {}) {
      const schema = structured ? StructuredVerdictSchema : RawVerdictSchema;
      const runner = chat.withStructuredOutput(schema, { includeRaw: true });
      const res = await runner.invoke(
        [
          ['system', system],
          ['human', user],
        ],
        signal ? { signal } : undefined
      );

      const parsed = res && res.parsed !== undefined ? res.parsed : res;
      const usage = res && res.raw && res.raw.usage_metadata;
      if (parsed && typeof parsed === 'object' && usage) {
        parsed._tokensIn = usage.input_tokens || 0;
        parsed._tokensOut = usage.output_tokens || 0;
      }
      return parsed;
    },
  };
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Model output contains no JSON object');
  }
  return text.slice(start, end + 1);
}

function safeParseJson(text) {
  const jsonStr = extractJson(text);
  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    try {
      const sanitized = jsonStr.replace(/\\(?!["\\/bfnrt]|u[0-9a-fA-F]{4})/g, () => '\\\\');
      return JSON.parse(sanitized);
    } catch {
      throw err;
    }
  }
}

function createMockProvider(script = []) {
  const queue = [...script];
  let calls = 0;
  return {
    name: 'mock',
    get calls() {
      return calls;
    },
    async grade(prompt, opts) {
      calls += 1;
      if (queue.length === 0) {
        throw new Error('Mock provider script exhausted');
      }
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(prompt, opts);
      return next;
    },
  };
}

module.exports = {
  createGeminiProvider,
  createMockProvider,
  extractJson,
  safeParseJson,
};
