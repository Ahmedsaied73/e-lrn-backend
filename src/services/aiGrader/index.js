'use strict';

/**
 * aiGrader/index.js — pure essay evaluation.
 *
 * FR-13: Supports optional structured rubric [{id, description, points}].
 * FR-21: Real AbortController timeout + smart retries (transient errors only
 * with exponential backoff + jitter + Retry-After; validation errors get 1
 * repair retry).
 */

const { buildGradingPrompt, PROMPT_VERSION } = require('./prompts');
const { validateVerdict, validateStructuredVerdict } = require('./schemas');
const { toGraderText } = require('../../lib/richContent/grader');

const log = {
  info: (event, ctx = {}) => console.log(`[INFO] ${event}`, JSON.stringify(ctx)),
  warn: (event, ctx = {}) => console.warn(`[WARN] ${event}`, JSON.stringify(ctx)),
};

const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_MAX_ATTEMPTS = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientError(err) {
  if (!err) return false;
  const status = err.status || err.statusCode || (err.response && err.response.status);
  if (status === 429 || (status >= 500 && status < 600)) return true;
  const msg = String(err.message || '');
  return /timed out|timeout|ECONNRESET|ETIMEDOUT|429|503|502|rate limit/i.test(msg);
}

function parseRetryAfter(err) {
  const header = err && err.response && err.response.headers && err.response.headers['retry-after'];
  if (!header) return 0;
  const sec = Number(header);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
}

function withTimeout(fn, ms) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`AI grading timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([fn(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

async function gradeEssay(input, provider, options = {}) {
  const {
    questionTitle = '',
    studentAnswer = '',
    modelAnswer = '',
    rubric = null,
    maxPoints = 0,
  } = input || {};
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    model = (provider && provider.name) || 'unknown',
  } = options;

  if (!Number.isSafeInteger(maxPoints) || maxPoints <= 0) {
    throw new Error('gradeEssay requires a positive integer maxPoints');
  }
  if (typeof studentAnswer !== 'string' || !studentAnswer.trim()) {
    throw new Error('gradeEssay requires a non-empty student answer');
  }
  if (typeof modelAnswer !== 'string' || !modelAnswer.trim()) {
    throw new Error('gradeEssay requires a non-empty model answer');
  }
  if (!provider || typeof provider.grade !== 'function') {
    throw new Error('gradeEssay requires a provider with grade()');
  }

  const prompt = buildGradingPrompt({ questionTitle, modelAnswer, rubric, studentAnswer, maxPoints });
  const isStructured = prompt.structured === true;
  const convertedStudent = toGraderText(studentAnswer);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = await withTimeout((signal) => provider.grade(prompt, { signal }), timeoutMs);
      const tokensIn = raw && typeof raw._tokensIn === 'number' ? raw._tokensIn : 0;
      const tokensOut = raw && typeof raw._tokensOut === 'number' ? raw._tokensOut : 0;

      const verdict = isStructured
        ? validateStructuredVerdict(raw, rubric, maxPoints, convertedStudent)
        : validateVerdict(raw, maxPoints);

      log.info('ai.grade.completed', {
        model,
        promptVersion: prompt.version,
        maxPoints,
        score: verdict.score,
        confidence: verdict.confidence,
        attempts: attempt,
        tokensIn,
        tokensOut,
      });

      return { ...verdict, model, promptVersion: prompt.version, tokensIn, tokensOut };
    } catch (err) {
      lastError = err;
      log.warn('ai.grade.attempt_failed', { model, attempt, maxAttempts, error: err.message });

      if (attempt >= maxAttempts) break;
      const isValidation = err.code === 'SCALE_MISMATCH' || err.name === 'ZodError';
      const transient = isTransientError(err);
      if (!transient && !isValidation) break;
      if (isValidation && attempt > 1) break;

      const baseDelay = Math.min(30000, (2 ** attempt) * 1000 + Math.random() * 1000);
      const retryAfter = parseRetryAfter(err);
      await sleep(Math.max(baseDelay, retryAfter));
    }
  }
  throw lastError;
}

module.exports = {
  gradeEssay,
  PROMPT_VERSION,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
};
