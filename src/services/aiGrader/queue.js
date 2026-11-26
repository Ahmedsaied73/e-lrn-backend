'use strict';

/**
 * queue.js — BullMQ plumbing for AI grading jobs.
 *
 * FR-23: Bulk enqueue (single findMany + createMany + addBulk) instead of
 * 3 sequential round-trips per essay question.
 */

const prisma = require('../../config/db');

const QUEUE_NAME = 'ai-grading';

let queue = null;
let queueConnection = null;

function logInfo(event, ctx = {}) {
  console.log(`[INFO] ${event}`, JSON.stringify(ctx));
}

function logWarn(event, ctx = {}) {
  console.warn(`[WARN] ${event}`, JSON.stringify(ctx));
}

function getGradingQueue() {
  if (!queue) {
    const { Queue } = require('bullmq');
    const { createRedisConnection } = require('../../integrations/redis/redisClient');
    queueConnection = createRedisConnection({ maxRetriesPerRequest: null });
    queue = new Queue(QUEUE_NAME, {
      connection: queueConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30000 },
        removeOnComplete: { count: 200, age: 86400 },
        removeOnFail: { count: 1000, age: 604800 },
      },
    });
  }
  return queue;
}

async function closeGradingQueue() {
  if (!queue) return;
  const toClose = queue;
  const toCloseConn = queueConnection;
  queue = null;
  queueConnection = null;
  try {
    await toClose.close();
  } catch (err) {
    logWarn('ai.queue.close_failed', { error: err.message });
  }
  if (toCloseConn) {
    try {
      await toCloseConn.quit();
    } catch {
      try { toCloseConn.disconnect(); } catch { /* already gone */ }
    }
  }
}

function isAiQueueAvailable() {
  const config = require('../../config/env');
  if (config.features && config.features.aiGrader === false) return false;
  const { isRedisEnabled } = require('../../integrations/redis/redisClient');
  return isRedisEnabled();
}

async function enqueueAiGrading(attemptId, options = {}) {
  try {
    if (!isAiQueueAvailable()) return 0;
    const attempt = await prisma.quizAttempt.findUnique({
      where: { id: attemptId },
      include: { quiz: { select: { answerKey: true } } },
    });
    if (!attempt || attempt.status !== 'GRADING') return 0;

    const { resolveAttemptKey } = require('../../utils/quizKeyResolver');
    const answerKey = resolveAttemptKey(attempt);
    const responses = attempt.responses || {};
    const { shortHash } = require('../../integrations/redis/cache');
    const retryNonce = options.freshJobIds ? `-${Date.now().toString(36)}` : '';

    // FR-23: single findMany instead of per-question findUnique
    const existingJobs = await prisma.aiGradingJob.findMany({
      where: { attemptId },
      select: { questionName: true, status: true },
    });
    const existingMap = new Map(existingJobs.map((j) => [j.questionName, j.status]));

    const toCreate = [];
    const toEnqueue = [];

    for (const [qName, entry] of Object.entries(answerKey)) {
      if (!entry || entry.type !== 'comment') continue;
      if (!entry.ai || entry.ai.enabled !== true) continue;
      const answer = responses[qName];
      if (typeof answer !== 'string' || !answer.trim()) continue;

      const status = existingMap.get(qName);
      if (status === 'DONE_APPLIED' || status === 'SYSTEM_GRADED' || status === 'NEEDS_REVIEW') {
        continue;
      }
      if (!status) {
        toCreate.push({ attemptId, questionName: qName, status: 'PENDING', nextRunAt: new Date() });
      }
      toEnqueue.push({ attemptId, questionName: qName });
    }

    if (toEnqueue.length === 0) return 0;

    if (toCreate.length > 0) {
      await prisma.aiGradingJob.createMany({ data: toCreate, skipDuplicates: true });
    }

    await getGradingQueue().addBulk(
      toEnqueue.map((j) => ({
        name: 'grade-essay',
        data: j,
        opts: {
          jobId: `ai-${j.attemptId}-${j.questionName.replace(/[^a-zA-Z0-9_-]/g, '_')}-${shortHash(j.questionName)}${retryNonce}`,
        },
      }))
    );

    logInfo('ai.queue.enqueued', { attemptId, enqueued: toEnqueue.length });
    return toEnqueue.length;
  } catch (err) {
    logWarn('ai.queue.enqueue_failed', { attemptId, error: err.message });
    return 0;
  }
}

module.exports = {
  QUEUE_NAME,
  getGradingQueue,
  closeGradingQueue,
  isAiQueueAvailable,
  enqueueAiGrading,
};
