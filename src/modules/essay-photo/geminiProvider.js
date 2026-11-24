'use strict';

const { AppError } = require('../../utils/AppError');
const { SYSTEM_PROMPT, USER_PROMPT } = require('./prompt');
const { geminiOutputSchema, GEMINI_RESPONSE_JSON_SCHEMA } = require('./schema');
const defaultConfig = require('./config');

const MEDIA_RESOLUTION_MAP = {
  low: 'MEDIA_RESOLUTION_LOW',
  medium: 'MEDIA_RESOLUTION_MEDIUM',
  high: 'MEDIA_RESOLUTION_HIGH',
};

function resolveThinkingLevel(model, requested) {
  const level = (requested || 'low').toLowerCase();
  if (String(model).includes('gemini-3.8-flash') && level === 'minimal') {
    return 'low';
  }
  return level;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createGeminiProvider(opts = {}) {
  const fetchFn = opts.fetchFn || globalThis.fetch;
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : defaultConfig.apiKey;
  const timeoutMs = opts.timeoutMs || defaultConfig.timeoutMs || 15000;
  const mediaResolution = opts.mediaResolution || defaultConfig.mediaResolution || 'high';
  const thinkingLevel = opts.thinkingLevel || defaultConfig.thinkingLevel || 'low';
  const maxRetries = opts.maxRetries !== undefined ? opts.maxRetries : 2;
  const sleepFn = opts.sleepFn || sleep;

  async function extract({ imageBuffer, mimeType = 'image/jpeg', model }) {
    if (!apiKey) {
      throw new AppError('Gemini API key is not configured.', 503, 'ESSAY_PHOTO_UNCONFIGURED');
    }
    const targetModel = model || defaultConfig.model || 'gemini-3.1-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      targetModel
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: USER_PROMPT },
            { inlineData: { mimeType, data: imageBuffer.toString('base64') } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseJsonSchema: GEMINI_RESPONSE_JSON_SCHEMA,
        mediaResolution: MEDIA_RESOLUTION_MAP[mediaResolution] || 'MEDIA_RESOLUTION_HIGH',
        thinkingConfig: {
          thinkingLevel: resolveThinkingLevel(targetModel, thinkingLevel),
        },
      },
    });

    const startMs = Date.now();
    let lastErr;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (res.status === 429 || res.status >= 500) {
          lastErr = new AppError(
            `Gemini upstream error (${res.status}).`,
            res.status === 429 ? 429 : 503,
            'GEMINI_UPSTREAM_ERROR'
          );
          if (attempt < maxRetries) {
            const jitter = Math.floor(Math.random() * 200);
            await sleepFn(300 * 2 ** attempt + jitter);
            continue;
          }
          throw lastErr;
        }

        if (!res.ok) {
          throw new AppError(`Gemini request failed (${res.status}).`, 502, 'GEMINI_REQUEST_FAILED');
        }

        const json = await res.json();
        const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawText || typeof rawText !== 'string') {
          throw new AppError('Empty response from Gemini.', 422, 'GEMINI_INVALID_OUTPUT');
        }

        let parsedJson;
        try {
          parsedJson = JSON.parse(rawText);
        } catch {
          throw new AppError('Invalid JSON response from Gemini.', 422, 'GEMINI_INVALID_OUTPUT');
        }

        const validated = geminiOutputSchema.safeParse(parsedJson);
        if (!validated.success) {
          throw new AppError('Gemini response failed schema validation.', 422, 'GEMINI_INVALID_OUTPUT');
        }

        const usage = json?.usageMetadata || {};
        const inputTokens = Number(usage.promptTokenCount) || 0;
        const outputTokens = Number(usage.candidatesTokenCount) || 0;
        const thinkingTokens = Number(usage.thoughtsTokenCount) || 0;

        return {
          ...validated.data,
          modelId: targetModel,
          inputTokens,
          outputTokens,
          thinkingTokens,
          estimatedCostUsd: defaultConfig.estimateCostUsd(
            targetModel,
            inputTokens,
            outputTokens,
            thinkingTokens
          ),
          latencyMs: Date.now() - startMs,
        };
      } catch (err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') {
          lastErr = new AppError('Essay photo extraction timed out.', 504, 'ESSAY_PHOTO_TIMEOUT');
          throw lastErr;
        }
        if (err instanceof AppError) {
          if (attempt < maxRetries && err.code === 'GEMINI_UPSTREAM_ERROR') {
            continue;
          }
          throw err;
        }
        lastErr = new AppError('Gemini network failure.', 503, 'GEMINI_NETWORK_ERROR');
        if (attempt < maxRetries) {
          const jitter = Math.floor(Math.random() * 200);
          await sleepFn(300 * 2 ** attempt + jitter);
          continue;
        }
        throw lastErr;
      }
    }

    throw lastErr || new AppError('Gemini extraction failed.', 503, 'GEMINI_UPSTREAM_ERROR');
  }

  return { extract };
}

const defaultProvider = createGeminiProvider();

module.exports = {
  createGeminiProvider,
  extract: defaultProvider.extract,
  resolveThinkingLevel,
};
