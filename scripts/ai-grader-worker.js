#!/usr/bin/env node
'use strict';

/**
 * Standalone AI-grading worker process (multi-instance / resale deployment).
 *
 * Run with:  npm run worker:ai
 *
 * In the default (monolith) topology, app.js starts the AI grading worker
 * in-process. When you want grading isolated on its own instance (auto-scaling,
 * dedicated worker nodes, or keeping the API process small), start this script
 * instead and set AI_WORKER_PROCESS=true on the API instances so they do NOT
 * spawn their own in-process worker (see app.js).
 *
 * Both the in-process and standalone paths share the same startAiGradingWorker
 * entrypoint from src/services/aiGrader/worker.js — identical observability,
 * budget guard, and shutdown behavior. This process exists only to host it,
 * so SIGTERM/SIGINT perform a graceful BullMQ close, not a hard kill.
 */

require('dotenv').config();

const { startAiGradingWorker, stopAiGradingWorker } = require('../src/services/aiGrader/worker');

const worker = startAiGradingWorker();
if (!worker) {
  // startAiGradingWorker returns null when Redis is disabled or GEMINI_API_KEY
  // is missing (module self-guards). A standalone worker process that cannot
  // work must exit loudly — unlike the API process, there is no HTTP surface
  // to serve without it.
  console.error('[FATAL] AI grading worker could not start. Set REDIS_ENABLED=true, GEMINI_API_KEY, and AI_GRADER_ENABLED=true (default), or do not run this process.');
  process.exit(1);
}

console.log('[WORKER] AI grading worker process online, queue: ai-grading');

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[WORKER] ${signal} received — draining BullMQ worker...`);
  const force = setTimeout(() => {
    console.error('[WORKER] drain timeout — forcing exit');
    process.exit(1);
  }, 10000);
  force.unref();
  stopAiGradingWorker()
    .catch((err) => console.warn('[WORKER] stop failed:', err.message))
    .finally(() => {
      require('../src/config/db').$disconnect?.().catch(() => {});
      console.log('[WORKER] clean exit');
      process.exit(0);
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[WORKER][FATAL] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[WORKER][FATAL] unhandledRejection:', reason);
  process.exit(1);
});