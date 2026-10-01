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
// The ioredis instance we inject as the queue's connection. BullMQ treats a
// caller-provided connection as EXTERNALLY OWNED and does not quit it in
// Queue.close() — so we keep the reference and close it ourselves. Without
// this the socket stays open after close and a node:test child process never
// exits (verified: `node --test tests/redis-caches-p45.test.js` hung with all
// assertions green until this was fixed).
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
      // Queue-level defaults so every add path (submit, admin retry, future
      // callers) gets the same retry + retention policy. Retention is
      // count-AND-age bounded: terminal jobs self-prune, keeping Redis memory
      // flat; the AiGradingJob DB row remains the durable audit trail.
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30000 },
        removeOnComplete: { count: 200, age: 86400 }, // keep last 200, never longer than 24h
        // Failed jobs linger (last 1000, up to 7 days): BullMQ dedupes a
        // re-add by jobId while the previous failed job still sits in the
        // failed set — see the freshJobIds note in enqueueAiGrading.
        removeOnFail: { count: 1000, age: 604800 },
      },
    });
  }
  return queue;
}

/**
 * Close the queue's dedicated Redis connection (SIGTERM/SIGINT drain).
 * No-op when the queue was never created.
 */
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
  // BullMQ does not own an injected connection, so Queue.close() alone leaves
  // the socket open. Quit it here — otherwise SIGTERM drain (app.js) and
  // node:test child processes both keep a live handle forever.
  if (toCloseConn) {
    try {
      await toCloseConn.quit();
    } catch {
      try { toCloseConn.disconnect(); } catch { /* already gone */ }
    }
  }
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
 *
 * `options.freshJobIds == true` (manual admin retry only) appends a nonce to
 * each BullMQ jobId so a replay is genuinely re-scheduled even while the
 * previous failed job still sits in BullMQ's failed set (removeOnFail keeps
 * the last 1000 failed jobs for up to 7 days, and BullMQ would otherwise
 * dedupe the re-add by jobId). The DB row upsert still guards idempotency
 * (FAILED→PENDING once), and processGradingJob re-validates every guard
 * before writing, so double-processing is impossible either way.
 */
async function enqueueAiGrading(attemptId, options = {}) {
  try {
    if (!isAiQueueAvailable()) return 0;
    const attempt = await prisma.quizAttempt.findUnique({
      where: { id: attemptId },
      include: { quiz: { select: { answerKey: true } } },
    });
    if (!attempt || attempt.status !== 'GRADING') return 0;
    // Q-5: enumerate the attempt's frozen essays, never the live quiz row.
    const { resolveAttemptKey } = require('../../utils/quizKeyResolver');
    const answerKey = resolveAttemptKey(attempt);
    const responses = attempt.responses || {};
    let enqueued = 0;
    const { shortHash } = require('../../integrations/redis/cache');
    // Nonce for fresh re-schedule: a single timestamp-suffix per invocation so
    // a manual retry never collides with the original (or a recent) failed job
    // still retained by removeOnFail (count 1000 / age 7d — a job-count/age
    // retention bound, not a time window). On normal submit-path calls
    // (freshJobIds unset) this stays empty — jobId replay-protection intact.
    const retryNonce = options.freshJobIds ? `-${Date.now().toString(36)}` : '';
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
          // A shortHash suffix keeps distinct question names that sanitize to
          // the same string from colliding on the same BullMQ jobId (BullMQ
          // dedupes by jobId, so a collision would silently drop a job).
          // Retry + retention options live in the Queue's defaultJobOptions;
          // only the dedupe-anchoring jobId is per-add.
          jobId: `ai-${attemptId}-${qName.replace(/[^a-zA-Z0-9_-]/g, '_')}-${shortHash(qName)}${retryNonce}`,
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
  closeGradingQueue,
  isAiQueueAvailable,
  enqueueAiGrading,
};
