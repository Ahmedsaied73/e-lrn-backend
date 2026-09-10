'use strict';

/**
 * queue.js — BullMQ plumbing for AI grading jobs. No grading logic here.
 *
 * One BullMQ job per (attempt, essay question); jobId `ai-{attemptId}-{qName}`
 * (sanitized) makes re-enqueue a no-op while a job is pending (replay protection).
 * The AiGradingJob DB row is the durable audit trail + cross-restart
 * idempotency key; BullMQ holds the live queue in Redis.
 *
 * enqueueAiGrading() never throws — submitAttempt must not fail because the
 * queue is down. The human inbox is always the fallback.
 */

const prisma = require('../../config/db');

const QUEUE_NAME = 'ai-grading';

let queue = null;

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
    queue = new Queue(QUEUE_NAME, {
      connection: createRedisConnection({ maxRetriesPerRequest: null }),
    });
  }
  return queue;
}

function isAiQueueAvailable() {
  // Queue usability needs Redis only — NOT the model key. Jobs for a keyless
  // server simply wait until a keyed worker drains them; every guard in the
  // processor (still GRADING? still enabled? still ungraded?) makes late
  // processing safe. The worker itself still requires the key (see worker.js).
  // The AI_GRADER_ENABLED module flag gates everything (see M0a).
  const config = require('../../config/env');
  if (config.features && config.features.aiGrader === false) return false;
  const { isRedisEnabled } = require('../../integrations/redis/redisClient');
  return isRedisEnabled();
}

/**
 * Enqueue AI grading for every AI-enabled, answered, ungraded essay question
 * on a GRADING attempt. Safe to call repeatedly (unique jobId + DB upsert).
 * Returns the number of jobs enqueued. Never throws.
 */
async function enqueueAiGrading(attemptId) {
  try {
    if (!isAiQueueAvailable()) return 0;
    const attempt = await prisma.quizAttempt.findUnique({
      where: { id: attemptId },
      include: { quiz: { select: { answerKey: true } } },
    });
    if (!attempt || attempt.status !== 'GRADING') return 0;
    const answerKey = attempt.quiz.answerKey || {};
    const responses = attempt.responses || {};
    let enqueued = 0;
    for (const [qName, entry] of Object.entries(answerKey)) {
      if (!entry || entry.type !== 'comment') continue;
      if (!entry.ai || entry.ai.enabled !== true) continue;
      const answer = responses[qName];
      if (typeof answer !== 'string' || !answer.trim()) continue;
      const existing = await prisma.aiGradingJob.findUnique({
        where: { attemptId_questionName: { attemptId, questionName: qName } },
      });
      if (existing && existing.status === 'DONE') continue; // already graded — never re-queue
      await prisma.aiGradingJob.upsert({
        where: { attemptId_questionName: { attemptId, questionName: qName } },
        update: { status: 'PENDING', error: null },
        create: { attemptId, questionName: qName },
      });
      await getGradingQueue().add(
        'grade-essay',
        { attemptId, questionName: qName },
        {
          // BullMQ jobIds must not contain ':' — sanitize admin-authored names.
          jobId: `ai-${attemptId}-${qName.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 30000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        }
      );
      enqueued += 1;
    }
    if (enqueued > 0) {
      logInfo('ai.queue.enqueued', { attemptId, enqueued });
    }
    return enqueued;
  } catch (err) {
    logWarn('ai.queue.enqueue_failed', { attemptId, error: err.message });
    return 0;
  }
}

module.exports = {
  QUEUE_NAME,
  getGradingQueue,
  isAiQueueAvailable,
  enqueueAiGrading,
};
