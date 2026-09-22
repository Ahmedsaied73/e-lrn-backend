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
const { gradeEssay, DEFAULT_MAX_ATTEMPTS } = require('./index');
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

// Atomic reserve: INCRBY in one round trip, then heal the TTL whenever the
// key has none (pttl == -1): covers both the first hit and legacy TTL-less
// leftovers from the pre-Lua GET → INCRBY → conditional EXPIRE sequence,
// whose 3 round trips could skip the EXPIRE under a race. Returns the count.
const BUDGET_RESERVE_LUA = `
local count = redis.call('incrby', KEYS[1], ARGV[1])
if redis.call('pttl', KEYS[1]) == -1 then
  redis.call('expire', KEYS[1], 86400)
end
return count
`;

/**
 * Cost guard: at most N paid model calls per UTC day (Redis counter, 24h TTL).
 * Counts RESERVED worst-case calls, not actuals: one job may invoke the model
 * up to maxAttempts times (gradeEssay retries technical failures), so we
 * increment by `cost` (= that bound) up front. Over-counts when the first try
 * succeeds — the safe direction for a tripwire. Failing jobs may use fewer;
 * the gap is accepted and documented here, never silently grown.
 * Returns true when the call may proceed, false when exhausted — the job stays
 * queued for human grading. Never throws.
 */
async function checkBudget(cost = 1) {
  const n = Number.isSafeInteger(cost) && cost > 0 ? cost : 1;
  try {
    const { getRedis, ensureConnected } = require('../../integrations/redis/redisClient');
    // Await the handshake (bounded): without this, a cold client rejects and
    // the fail-open below would wrongly approve the spend.
    await ensureConnected(3000).catch(() => false);
    const client = getRedis();
    if (!client || client.status !== 'ready') return true; // fail-open: no Redis, no budget tracking
    const key = budgetKey();
    // Reserve first, then compare: count - n is the pre-increment value the
    // old GET saw, so the tripwire decision boundary is unchanged. Rejected
    // calls keep incrementing (the counter may overshoot the budget) —
    // harmless: the key is a 24h tripwire, not an exact meter.
    const count = Number(await client.eval(BUDGET_RESERVE_LUA, 1, key, n));
    const used = count - n;
    if (used >= dailyBudget()) {
      logWarn('ai.budget.exhausted', { used, budget: dailyBudget() });
      return false;
    }
    return true;
  } catch (err) {
    logWarn('ai.budget.check_failed', { error: err.message });
    return true; // fail-open: budget system must never block grading by itself
  }
}

async function markJob(attemptId, questionName, patch) {
  const where = { attemptId_questionName: { attemptId, questionName } };
  try {
    await prisma.aiGradingJob.update({
      where,
      data: { ...patch, updatedAt: new Date() },
    });
    return;
  } catch (err) {
    if (!err || err.code !== 'P2025') {
      logWarn('ai.worker.job_row_missing', { attemptId, questionName, error: err && err.message });
      return;
    }
  }
  // No row yet (graded without enqueue reaching the DB first) — create the
  // audit skeleton instead of dropping the record.
  try {
    const { tries, ...rest } = patch;
    await prisma.aiGradingJob.create({
      data: {
        attemptId,
        questionName,
        tries: tries && typeof tries.increment === 'number' ? tries.increment : 0,
        ...rest,
      },
    });
  } catch (err) {
    logWarn('ai.worker.job_row_create_failed', { attemptId, questionName, error: err && err.message });
  }
}

async function processGradingJob(job, providerFactory = defaultProviderFactory) {
  const { attemptId, questionName } = job.data || {};
  if (!Number.isSafeInteger(attemptId) || typeof questionName !== 'string' || !questionName) {
    throw new Error('Invalid job payload (expected {attemptId, questionName})');
  }

  // Module flag is honored at processing time too: disabling mid-queue parks
  // jobs (they stay PENDING for later or human grading) instead of grading.
  const modCfg = require('../../config/env');
  if (modCfg.features && modCfg.features.aiGrader === false) {
    logInfo('ai.worker.skipped_module_off', { attemptId, questionName });
    return { skipped: 'module-off' };
  }

  const attempt = await prisma.quizAttempt.findUnique({
    where: { id: attemptId },
    include: { quiz: { select: { answerKey: true } } },
  });
  if (!attempt || attempt.status !== 'GRADING') {
    logInfo('ai.worker.skipped_not_grading', { attemptId, questionName });
    return { skipped: 'not-grading' };
  }

  // Q-5: prompt context comes from the frozen start-time key.
  const { resolveAttemptKey } = require('../quizService');
  const entry = (resolveAttemptKey(attempt) || {})[questionName];
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

  // AI-4: reserve the worst case (gradeEssay may call the model up to
  // maxAttempts times). Over-counts first-try successes — safe direction.
  if (!(await checkBudget(DEFAULT_MAX_ATTEMPTS))) {
    logInfo('ai.worker.skipped_budget', { attemptId, questionName });
    return { skipped: 'budget-exhausted' };
  }

  const provider = await providerFactory();
  // AI-1: honor the configured timeout (previously always the 45s default).
  const aiCfg = require('../../config/env').aiGrader || {};
  let verdict;
  try {
    verdict = await gradeEssay(
      {
        questionTitle: questionName,
        studentAnswer: answer,
        modelAnswer: entry.modelAnswer,
        rubric: typeof entry.rubric === 'string' ? entry.rubric : null,
        maxPoints: entry.points,
      },
      provider,
      { model: provider.name, timeoutMs: aiCfg.timeoutMs }
    );
  } catch (err) {
    // AI-3: terminal failure records FAILED + error on the row (previously
    // orphan PENDING with no trace). BullMQ may still retry per its policy;
    // a later success overwrites this via the DONE patch below.
    await markJob(attemptId, questionName, {
      status: 'FAILED',
      error: String((err && err.message) || err).slice(0, 1000),
    });
    throw err;
  }

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
  // An explicitly injected provider (checks) bypasses the key/module guards —
  // the caller owns credentials in that case. Default path needs Redis, a key,
  // and the aiGrader module flag.
  const customProvider = Boolean(options.providerFactory);
  if (!isRedisEnabled()) {
    logWarn('ai.worker.not_started', { reason: 'Redis disabled' });
    return null;
  }
  const moduleOn = !config.features || config.features.aiGrader !== false;
  if (!customProvider && ((!config.aiGrader || !config.aiGrader.configured) || !moduleOn)) {
    logWarn('ai.worker.not_started', { reason: 'AI grader disabled or GEMINI_API_KEY missing' });
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

/**
 * Stop the worker gracefully (SIGTERM/SIGINT drain). No-op when never started.
 * Closes the BullMQ worker so its dedicated Redis connection is released
 * before the shared cache client is torn down.
 */
async function stopAiGradingWorker() {
  if (!worker) return;
  const toClose = worker;
  worker = null;
  try {
    await toClose.close();
    logInfo('ai.worker.stopped', { queue: QUEUE_NAME });
  } catch (err) {
    logWarn('ai.worker.stop_failed', { error: err.message });
  }
}

module.exports = {
  QUEUE_NAME,
  processGradingJob,
  startAiGradingWorker,
  stopAiGradingWorker,
  checkBudget, // exported for harness verification (tripwire math)
};
