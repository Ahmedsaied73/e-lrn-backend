'use strict';

/**
 * worker.js — BullMQ processor for AI essay grading + lifecycle.
 *
 * Flow per job {attemptId, questionName}:
 *   1. Guard: attempt still GRADING, question AI-enabled + answered + ungraded
 *      (human grades always win; anything else → done/skipped, no write).
 *   2. gradeEssay() via injected provider (Gemini in prod, mock in checks).
 *   3. Persist verdict to the AiGradingJob row (audit, always).
 *   4. Confidence >= threshold → applyAiVerdict() in quizService, which
 *      finalizes the attempt ONLY when every essay now has a score.
 *      Below threshold → stays GRADING for the human inbox.
 *
 * Logging includes full grading context (question, model/human answers,
 * verdict) per the approved debuggability decision — never credentials.
 */

const prisma = require('../../config/db');
const { gradeEssay } = require('./index');
const { createGeminiProvider } = require('./provider');
const { QUEUE_NAME } = require('./queue');

function logInfo(event, ctx = {}) {
  console.log(`[INFO] ${event}`, JSON.stringify(ctx));
}

function logWarn(event, ctx = {}) {
  console.warn(`[WARN] ${event}`, JSON.stringify(ctx));
}

function defaultProviderFactory() {
  const config = require('../../config/env');
  if (!config.aiGrader || !config.aiGrader.apiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }
  return createGeminiProvider({ apiKey: config.aiGrader.apiKey, model: config.aiGrader.model });
}

function confidenceThreshold() {
  const config = require('../../config/env');
  return config.aiGrader ? config.aiGrader.confidenceThreshold : 0.8;
}

function dailyBudget() {
  const raw = Number(process.env.AI_GRADER_DAILY_BUDGET);
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : 1000;
}

function budgetKey(date = new Date()) {
  return `ai:budget:${date.toISOString().slice(0, 10)}`;
}

/**
 * Cost guard: at most N paid model calls per UTC day (Redis counter, 24h TTL).
 * Returns true when the call may proceed (and counts it), false when the
 * budget is exhausted — the job stays queued for human grading. Never throws.
 */
async function checkBudget() {
  try {
    const { getRedis, ensureConnected } = require('../../integrations/redis/redisClient');
    // Await the handshake (bounded): without this, a cold client rejects and
    // the fail-open below would wrongly approve the spend.
    await ensureConnected(3000).catch(() => false);
    const client = getRedis();
    if (!client || client.status !== 'ready') return true; // fail-open: no Redis, no budget tracking
    const key = budgetKey();
    const used = Number(await client.get(key)) || 0;
    if (used >= dailyBudget()) {
      logWarn('ai.budget.exhausted', { used, budget: dailyBudget() });
      return false;
    }
    const count = await client.incr(key);
    if (count === 1) {
      await client.expire(key, 86400).catch(() => {});
    }
    return true;
  } catch (err) {
    logWarn('ai.budget.check_failed', { error: err.message });
    return true; // fail-open: budget system must never block grading by itself
  }
}

async function markJob(attemptId, questionName, patch) {
  try {
    await prisma.aiGradingJob.update({
      where: { attemptId_questionName: { attemptId, questionName } },
      data: { ...patch, updatedAt: new Date() },
    });
  } catch (err) {
    logWarn('ai.worker.job_row_missing', { attemptId, questionName, error: err.message });
  }
}

async function processGradingJob(job, providerFactory = defaultProviderFactory) {
  const { attemptId, questionName } = job.data || {};
  if (!Number.isSafeInteger(attemptId) || typeof questionName !== 'string' || !questionName) {
    throw new Error('Invalid job payload (expected {attemptId, questionName})');
  }

  const attempt = await prisma.quizAttempt.findUnique({
    where: { id: attemptId },
    include: { quiz: { select: { answerKey: true } } },
  });
  if (!attempt || attempt.status !== 'GRADING') {
    logInfo('ai.worker.skipped_not_grading', { attemptId, questionName });
    return { skipped: 'not-grading' };
  }

  const entry = (attempt.quiz.answerKey || {})[questionName];
  if (!entry || entry.type !== 'comment' || !entry.ai || entry.ai.enabled !== true) {
    logInfo('ai.worker.skipped_not_enabled', { attemptId, questionName });
    return { skipped: 'not-enabled' };
  }

  const feedback = attempt.essayFeedback || {};
  const existing = feedback[questionName];
  if (existing && typeof existing.awarded === 'number') {
    logInfo('ai.worker.skipped_human_graded', { attemptId, questionName });
    return { skipped: 'human-graded' };
  }

  const answer = (attempt.responses || {})[questionName];
  if (typeof answer !== 'string' || !answer.trim()) {
    logInfo('ai.worker.skipped_no_answer', { attemptId, questionName });
    return { skipped: 'no-answer' };
  }

  await markJob(attemptId, questionName, { tries: { increment: 1 }, claimedAt: new Date() });

  if (!(await checkBudget())) {
    logInfo('ai.worker.skipped_budget', { attemptId, questionName });
    return { skipped: 'budget-exhausted' };
  }

  const provider = await providerFactory();
  const verdict = await gradeEssay(
    {
      questionTitle: questionName,
      studentAnswer: answer,
      modelAnswer: entry.modelAnswer,
      rubric: typeof entry.rubric === 'string' ? entry.rubric : null,
      maxPoints: entry.points,
    },
    provider,
    { model: provider.name }
  );

  const threshold = confidenceThreshold();
  const confident = verdict.confidence >= threshold;
  await markJob(attemptId, questionName, {
    status: 'DONE',
    confidence: verdict.confidence,
    applied: confident,
    verdict: { ...verdict },
    error: null,
  });

  logInfo('ai.grade.verdict', {
    attemptId,
    questionName,
    maxPoints: entry.points,
    score: verdict.score,
    confidence: verdict.confidence,
    threshold,
    applied: confident,
    model: verdict.model,
    promptVersion: verdict.promptVersion,
    studentAnswer: answer.slice(0, 10000),
    modelAnswer: (entry.modelAnswer || '').slice(0, 5000),
    rubric: (entry.rubric || '').slice(0, 5000),
    feedback: verdict.feedback,
  });

  if (!confident) {
    return { applied: false, confidence: verdict.confidence, threshold };
  }

  const quizService = require('../quizService');
  const applied = await quizService.applyAiVerdict(attemptId, questionName, {
    awarded: verdict.score,
    max: entry.points,
    feedback: verdict.feedback,
    confidence: verdict.confidence,
    model: verdict.model,
    promptVersion: verdict.promptVersion,
  });
  return { applied: true, finalized: applied.finalized, confidence: verdict.confidence };
}

let worker = null;

function startAiGradingWorker(options = {}) {
  const config = require('../../config/env');
  const { isRedisEnabled } = require('../../integrations/redis/redisClient');
  // An explicitly injected provider (checks) bypasses the key guard — the
  // caller owns credentials in that case. Default path needs a real key.
  const customProvider = Boolean(options.providerFactory);
  if ((!customProvider && (!config.aiGrader || !config.aiGrader.configured)) || !isRedisEnabled()) {
    logWarn('ai.worker.not_started', { reason: 'GEMINI_API_KEY missing or Redis disabled' });
    return null;
  }
  if (worker) return worker;
  const { Worker } = require('bullmq');
  const { createRedisConnection } = require('../../integrations/redis/redisClient');
  const providerFactory = options.providerFactory || defaultProviderFactory;
  worker = new Worker(
    QUEUE_NAME,
    (job) => processGradingJob(job, providerFactory),
    {
      // BullMQ mandates maxRetriesPerRequest: null (blocking semantics) —
      // always a dedicated connection, never the shared cache client.
      connection: createRedisConnection({ maxRetriesPerRequest: null }),
      concurrency: 2,
    }
  );
  worker.on('failed', (job, err) => {
    logWarn('ai.worker.job_failed', { jobId: job && job.id, error: err && err.message });
  });
  worker.on('error', (err) => {
    logWarn('ai.worker.error', { error: err && err.message });
  });
  logInfo('ai.worker.started', { queue: QUEUE_NAME, concurrency: 2 });
  return worker;
}

module.exports = {
  QUEUE_NAME,
  processGradingJob,
  startAiGradingWorker,
};
