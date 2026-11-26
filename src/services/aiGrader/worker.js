'use strict';

/**
 * worker.js — BullMQ processor for AI essay grading + lifecycle.
 *
 * Hardened 5-state machine:
 *   PENDING -> RUNNING (lease) -> DONE_APPLIED | NEEDS_REVIEW(reason)
 *
 * - FR-4: Lease-based claim (5 min leaseUntil)
 * - FR-5/FR-25: Token-based daily budget with reserve + refund + defer on exhaustion
 * - FR-6: providerFactory() inside try/catch; exhausted retries -> NEEDS_REVIEW(AI_FAILED)
 * - FR-7: Atomic verdict storage + application
 * - FR-10: Real question title from resolveAttemptSurvey()
 * - FR-14/15/16/17/18: Safety gates + per-quiz reviewMode
 * - FR-20: DB-level verdict cache via inputHash (re-runs safety gates)
 * - FR-24: Scrubbed logs (no student/model/rubric text)
 */

const crypto = require('crypto');
const prisma = require('../../config/db');
const { gradeEssay } = require('./index');
const { createGeminiProvider } = require('./provider');
const { QUEUE_NAME } = require('./queue');
const { toGraderText } = require('../../lib/richContent/grader');
const { MAX_STUDENT_CHARS, MAX_MODEL_CHARS, PROMPT_VERSION } = require('./prompts');
const { runSafetyGates } = require('./safety');
const { shouldAutoApply } = require('./reviewMode');

const LEASE_MS = 5 * 60 * 1000;

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

function dailyTokenBudget() {
  const raw = Number(process.env.AI_GRADER_DAILY_TOKEN_BUDGET);
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : 2000000;
}

function budgetKey(date = new Date()) {
  return `v1:ai:token_budget:${date.toISOString().slice(0, 10)}`;
}

function nextBudgetReset() {
  const d = new Date();
  d.setUTCHours(24, 0, 5, 0);
  return d;
}

const BUDGET_RESERVE_LUA = `
local count = redis.call('incrby', KEYS[1], ARGV[1])
if redis.call('pttl', KEYS[1]) == -1 then
  redis.call('expire', KEYS[1], 86400)
end
return count
`;

// Refund at most what is actually reserved: an earlier failed check may not
// have counted anything, and DECRBY alone could drive the key negative.
const BUDGET_REFUND_LUA = `
local current = tonumber(redis.call('get', KEYS[1]) or '0')
if current <= 0 then
  return 0
end
local amount = math.min(current, tonumber(ARGV[1]))
return redis.call('decrby', KEYS[1], amount)
`;

async function checkBudget(tokens = 1000, deps = {}) {
  const n = Number.isSafeInteger(tokens) && tokens > 0 ? tokens : 1000;
  const redis = deps.redis || require('../../integrations/redis/redisClient');
  try {
    const connected = await redis.ensureConnected(3000).catch(() => false);
    const client = redis.getRedis();
    if (connected === false || !client || client.status !== 'ready') {
      logWarn('ai.budget.unavailable', { reason: 'redis-not-ready' });
      return { allowed: false, reserved: 0 };
    }
    const key = budgetKey();
    const count = Number(await client.eval(BUDGET_RESERVE_LUA, 1, key, n));
    if (!Number.isSafeInteger(count) || count < n) {
      // The reply cannot be trusted, so do not claim a reservation the caller
      // might refund against an unrelated counter. Counts only — no content.
      logWarn('ai.budget.invalid_reply', { expectedMinimum: n, budget: dailyTokenBudget() });
      return { allowed: false, reserved: 0 };
    }
    const used = count - n;
    const limit = dailyTokenBudget();
    if (used >= limit) {
      logWarn('ai.budget.exhausted', { used, budget: limit });
      // The eval ran and reserved n even though this call is denied.
      return { allowed: false, reserved: n };
    }
    if (limit > 0 && count / limit >= 0.8) {
      logWarn('ai.budget.warning_80pct', { used: count, budget: limit });
    }
    return { allowed: true, reserved: n };
  } catch (err) {
    logWarn('ai.budget.check_failed', { error: err.message });
    return { allowed: false, reserved: 0 };
  }
}

async function refundBudget(tokens, deps = {}) {
  if (!Number.isSafeInteger(tokens) || tokens <= 0) return;
  try {
    const redis = deps.redis || require('../../integrations/redis/redisClient');
    const client = redis.getRedis();
    if (!client || client.status !== 'ready') return;
    await client.eval(BUDGET_REFUND_LUA, 1, budgetKey(), tokens);
  } catch {
    // non-fatal — the reserve has a 24h TTL and the reconciler will defer work
  }
}

function computeInputHash({ questionTitle, studentAnswer, modelAnswer, rubric, maxPoints, promptVersion, model }) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ questionTitle, studentAnswer, modelAnswer, rubric, maxPoints, promptVersion, model }))
    .digest('hex');
}

function extractQuestionTitle(surveyJson, questionName) {
  if (!surveyJson || !Array.isArray(surveyJson.pages)) return questionName;
  for (const page of surveyJson.pages) {
    if (!page || !Array.isArray(page.elements)) continue;
    for (const el of page.elements) {
      if (el && el.name === questionName && typeof el.title === 'string' && el.title.trim()) {
        return el.title.trim();
      }
    }
  }
  return questionName;
}

async function markJob(attemptId, questionName, patch) {
  const where = { attemptId_questionName: { attemptId, questionName } };
  try {
    await prisma.aiGradingJob.update({
      where,
      data: { ...patch, updatedAt: new Date() },
    });
  } catch (err) {
    logWarn('ai.worker.mark_job_failed', { attemptId, questionName, error: err && err.message });
  }
}

async function applyOrEscalate({ attempt, attemptId, questionName, entry, verdict, answer, inputHash, tokensIn, tokensOut }) {
  const threshold = confidenceThreshold();
  const feedback = attempt.essayFeedback || {};
  const existingEarned = Object.values(feedback).reduce(
    (sum, item) => sum + (item && typeof item.awarded === 'number' ? item.awarded : 0),
    0
  );
  const attemptScoreSoFar = (attempt.mcqEarned || 0) + existingEarned;

  const gates = runSafetyGates({
    studentAnswer: answer,
    modelAnswer: entry.modelAnswer,
    verdict,
    confidenceThreshold: threshold,
    attemptScoreSoFar,
    totalPoints: attempt.totalPoints || 0,
    passingScore: attempt.quiz ? attempt.quiz.passingScore : 50,
  });

  const reviewPolicy = gates.pass ? shouldAutoApply(attempt.quiz) : { apply: false, reason: gates.reason };

  if (!reviewPolicy.apply) {
    await markJob(attemptId, questionName, {
      status: 'NEEDS_REVIEW',
      reason: reviewPolicy.reason,
      confidence: verdict.confidence,
      applied: false,
      verdict: { ...verdict },
      criteriaBreakdown: verdict.criteriaBreakdown || null,
      inputHash,
      tokensIn,
      tokensOut,
      leaseUntil: null,
      error: null,
    });

    logInfo('ai.grade.escalated', {
      attemptId,
      questionName,
      reason: reviewPolicy.reason,
      confidence: verdict.confidence,
      inputHash,
    });
    return { applied: false, reason: reviewPolicy.reason, confidence: verdict.confidence };
  }

  // FR-7: attempt lock, grade, verdict storage and job completion are ONE
  // transaction — a failure anywhere rolls all three back to RUNNING. Lock
  // order matches the reconciler (QuizAttempt first, then AiGradingJob).
  const quizService = require('../quizService');
  const applied = await prisma.$transaction(async (tx) => {
    const result = await quizService.applyAiVerdictInTx(tx, attemptId, questionName, {
      awarded: verdict.score,
      max: entry.points,
      feedback: verdict.feedback,
      confidence: verdict.confidence,
      model: verdict.model,
      promptVersion: verdict.promptVersion,
    });

    const completed = await tx.aiGradingJob.updateMany({
      where: { attemptId, questionName, status: 'RUNNING' },
      data: {
        status: 'DONE_APPLIED',
        applied: true,
        appliedAt: new Date(),
        leaseUntil: null,
        confidence: verdict.confidence,
        verdict: { ...verdict },
        criteriaBreakdown: verdict.criteriaBreakdown || null,
        inputHash,
        tokensIn,
        tokensOut,
        error: null,
      },
    });
    if (completed.count !== 1) {
      // A reset/reclaim worker changed the job; roll the verdict back so the
      // reclaimed job can be retried instead of being silently overwritten.
      throw new Error(`AiGradingJob ${attemptId}/${questionName} is no longer RUNNING`);
    }
    return result;
  });

  if (applied.finalized) await quizService.postFinalize(attemptId, applied.userId);

  logInfo('ai.grade.applied', {
    attemptId,
    questionName,
    inputHash,
    maxPoints: entry.points,
    score: verdict.score,
    confidence: verdict.confidence,
    tokensIn,
    tokensOut,
  });

  return { applied: true, finalized: applied.finalized, confidence: verdict.confidence };
}

async function processGradingJob(job, providerFactory = defaultProviderFactory, options = {}) {
  const budget = options.budget || { check: checkBudget, refund: refundBudget };
  const { attemptId, questionName } = job.data || {};
  if (!Number.isSafeInteger(attemptId) || typeof questionName !== 'string' || !questionName) {
    throw new Error('Invalid job payload (expected {attemptId, questionName})');
  }

  const modCfg = require('../../config/env');
  if (modCfg.features && modCfg.features.aiGrader === false) {
    logInfo('ai.worker.deferred_module_off', { attemptId, questionName });
    await markJob(attemptId, questionName, {
      status: 'PENDING',
      nextRunAt: new Date(Date.now() + 5 * 60 * 1000),
      leaseUntil: null,
    });
    return { skipped: 'module-off' };
  }

  // FR-4: Atomic lease claim
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  const claimed = await prisma.aiGradingJob.updateMany({
    where: {
      attemptId,
      questionName,
      status: 'PENDING',
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
    },
    data: {
      status: 'RUNNING',
      claimedAt: now,
      leaseUntil,
      tries: { increment: 1 },
    },
  });

  if (claimed.count === 0) {
    logInfo('ai.worker.skipped_already_claimed_or_terminal', { attemptId, questionName });
    return { skipped: 'not-pending' };
  }

  const attempt = await prisma.quizAttempt.findUnique({
    where: { id: attemptId },
    include: { quiz: { select: { answerKey: true, surveyJson: true, passingScore: true, aiReviewMode: true } } },
  });

  if (!attempt || attempt.status !== 'GRADING') {
    await markJob(attemptId, questionName, { status: 'DONE_APPLIED', applied: false, leaseUntil: null });
    return { skipped: 'not-grading' };
  }

  const { resolveAttemptKey, resolveAttemptSurvey } = require('../quizService');
  const entry = (resolveAttemptKey(attempt) || {})[questionName];
  if (!entry || entry.type !== 'comment' || !entry.ai || entry.ai.enabled !== true) {
    await markJob(attemptId, questionName, { status: 'NEEDS_REVIEW', reason: 'NOT_AI_ENABLED', leaseUntil: null });
    return { skipped: 'not-enabled' };
  }

  const existing = (attempt.essayFeedback || {})[questionName];
  if (existing && typeof existing.awarded === 'number') {
    await markJob(attemptId, questionName, { status: 'DONE_APPLIED', applied: true, appliedAt: now, leaseUntil: null });
    return { skipped: 'human-graded' };
  }

  const answer = (attempt.responses || {})[questionName];
  if (typeof answer !== 'string' || !answer.trim()) {
    await markJob(attemptId, questionName, { status: 'SYSTEM_GRADED', applied: true, appliedAt: now, leaseUntil: null });
    return { skipped: 'no-answer' };
  }

  const convertedStudent = toGraderText(answer);
  const convertedModel = toGraderText(entry.modelAnswer);
  if (convertedStudent.length > MAX_STUDENT_CHARS || convertedModel.length > MAX_MODEL_CHARS) {
    await markJob(attemptId, questionName, {
      status: 'NEEDS_REVIEW',
      reason: 'EXCEEDS_CAP',
      confidence: 0,
      applied: false,
      leaseUntil: null,
      error: 'Converted text exceeds grader input cap; forwarded to human review',
    });
    return { skipped: 'exceeds-cap', forwardedToHuman: true };
  }

  const questionTitle = extractQuestionTitle(resolveAttemptSurvey(attempt), questionName);
  const modelName = (modCfg.aiGrader && modCfg.aiGrader.model) || 'gemini-3.6-flash';
  const inputHash = computeInputHash({
    questionTitle,
    studentAnswer: convertedStudent,
    modelAnswer: convertedModel,
    rubric: entry.rubric || null,
    maxPoints: entry.points,
    promptVersion: PROMPT_VERSION,
    model: modelName,
  });

  // FR-20: DB-level verdict cache lookup
  const cached = await prisma.aiGradingJob.findFirst({
    where: { inputHash, status: 'DONE_APPLIED', verdict: { not: null } },
    select: { verdict: true },
  });

  if (cached && cached.verdict) {
    logInfo('ai.grade.cache_hit', { attemptId, questionName, inputHash });
    return applyOrEscalate({
      attempt,
      attemptId,
      questionName,
      entry,
      verdict: cached.verdict,
      answer,
      inputHash,
      tokensIn: 0,
      tokensOut: 0,
    });
  }

  // FR-5: Token budget reserve
  const estimatedTokens = Math.ceil((convertedStudent.length + convertedModel.length) / 2) + 500;
  const budgetResult = await budget.check(estimatedTokens);
  if (!budgetResult.allowed) {
    // Refund only what was really reserved: a not-ready/throw check consumed
    // nothing, while the exhausted branch reserved before denying us.
    if (budgetResult.reserved) await budget.refund(budgetResult.reserved);
    await markJob(attemptId, questionName, {
      status: 'PENDING',
      nextRunAt: nextBudgetReset(),
      leaseUntil: null,
      tries: { decrement: 1 }, // the deferral is not a grader attempt
    });
    return { skipped: 'budget-deferred' };
  }

  // FR-6: providerFactory() inside try/catch
  let verdict;
  try {
    const provider = await providerFactory();
    const aiCfg = modCfg.aiGrader || {};
    verdict = await gradeEssay(
      {
        questionTitle,
        studentAnswer: answer,
        modelAnswer: entry.modelAnswer,
        rubric: entry.rubric || null,
        maxPoints: entry.points,
      },
      provider,
      { model: provider.name, timeoutMs: aiCfg.timeoutMs }
    );
  } catch (err) {
    // Every failure branch below returns or throws before the success-path
    // refund, so give back the whole reservation exactly once here.
    await budget.refund(estimatedTokens);

    const actualRow = await prisma.aiGradingJob.findUnique({
      where: { attemptId_questionName: { attemptId, questionName } },
      select: { tries: true, maxTries: true },
    });
    const exhausted = actualRow && actualRow.tries >= actualRow.maxTries;
    const reason = err.code === 'SCALE_MISMATCH' ? 'SCALE_MISMATCH' : (err.name === 'ZodError' ? 'INVALID_OUTPUT' : 'AI_FAILED');

    if (exhausted || err.code === 'SCALE_MISMATCH') {
      await markJob(attemptId, questionName, {
        status: 'NEEDS_REVIEW',
        reason,
        leaseUntil: null,
        error: String((err && err.message) || err).slice(0, 1000),
      });
      return { escalated: true, reason };
    }

    await markJob(attemptId, questionName, {
      status: 'PENDING',
      nextRunAt: new Date(Date.now() + 60 * 1000),
      leaseUntil: null,
      error: String((err && err.message) || err).slice(0, 1000),
    });
    throw err;
  }

  const actualTokens = (verdict.tokensIn || 0) + (verdict.tokensOut || 0);
  // Runs before applyOrEscalate: applied and escalated outcomes both refund
  // the over-estimate exactly once.
  if (estimatedTokens > actualTokens) {
    await budget.refund(estimatedTokens - actualTokens);
  }

  return applyOrEscalate({
    attempt,
    attemptId,
    questionName,
    entry,
    verdict,
    answer,
    inputHash,
    tokensIn: verdict.tokensIn || 0,
    tokensOut: verdict.tokensOut || 0,
  });
}

let worker = null;

function startAiGradingWorker(options = {}) {
  const config = require('../../config/env');
  const { isRedisEnabled } = require('../../integrations/redis/redisClient');
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
  const concurrency =
    options.concurrency ||
    (Number.isSafeInteger(Number(process.env.AI_GRADER_CONCURRENCY)) && Number(process.env.AI_GRADER_CONCURRENCY) > 0
      ? Number(process.env.AI_GRADER_CONCURRENCY)
      : 2);

  // FR-22: BullMQ rate limiter configurable via env
  const limiterMax = Number(process.env.AI_GRADER_RATE_LIMIT_MAX) || 30;
  const limiterDuration = Number(process.env.AI_GRADER_RATE_LIMIT_DURATION_MS) || 60000;

  worker = new Worker(
    QUEUE_NAME,
    (job) => processGradingJob(job, providerFactory),
    {
      connection: createRedisConnection({ maxRetriesPerRequest: null }),
      concurrency,
      limiter: { max: limiterMax, duration: limiterDuration },
    }
  );
  worker.on('failed', (job, err) => {
    logWarn('ai.worker.job_failed', { jobId: job && job.id, error: err && err.message });
  });
  worker.on('error', (err) => {
    logWarn('ai.worker.error', { error: err && err.message });
  });
  logInfo('ai.worker.started', { queue: QUEUE_NAME, concurrency });
  return worker;
}

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
  checkBudget,
  refundBudget,
  computeInputHash,
  extractQuestionTitle,
};
