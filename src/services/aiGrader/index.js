'use strict';

/**
 * aiGrader/index.js — the ONLY export the quiz flow touches.
 *
 *   gradeEssay(input, provider, options) -> Promise<Verdict>
 *
 * Pure evaluation: no database, no business rules, no totals. The caller
 * (worker.js) decides what a verdict MEANS (finalize vs human review) and
 * persists it through quizService. Retries cover technical failures only —
 * a confident verdict is never re-rolled, a doubtful one is never hidden.
 */

const { buildGradingPrompt, PROMPT_VERSION } = require('./prompts');
const { validateVerdict } = require('./schemas');

const log = {
  info: (event, ctx = {}) => console.log(`[INFO] ${event}`, JSON.stringify(ctx)),
  warn: (event, ctx = {}) => console.warn(`[WARN] ${event}`, JSON.stringify(ctx)),
};

const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_MAX_ATTEMPTS = 2;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`AI grading timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = await withTimeout(provider.grade(prompt), timeoutMs);
      const verdict = validateVerdict(raw, maxPoints);
      log.info('ai.grade.completed', {
        model,
        promptVersion: prompt.version,
        maxPoints,
        score: verdict.score,
        confidence: verdict.confidence,
        attempts: attempt,
        budgetOverridden: verdict.budgetOverridden,
      });
      return { ...verdict, model, promptVersion: prompt.version };
    } catch (err) {
      lastError = err;
      log.warn('ai.grade.attempt_failed', { model, attempt, maxAttempts, error: err.message });
    }
  }
  throw lastError;
}

module.exports = {
  gradeEssay,
  PROMPT_VERSION,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS, // worst-case model calls per gradeEssay invocation
};
