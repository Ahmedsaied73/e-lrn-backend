'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const CONTROLLER_PATH = require.resolve('../src/controllers/aiGraderAdminController');
const DB_PATH = require.resolve('../src/config/db');
const QUEUE_PATH = require.resolve('../src/services/aiGrader/queue');

function makePrismaStub() {
  return {
    aiGradingJob: {
      async groupBy() {
        return [
          { status: 'PENDING', _count: { _all: 3 } },
          { status: 'RUNNING', _count: { _all: 2 } },
          { status: 'DONE_APPLIED', _count: { _all: 7 } },
          { status: 'SYSTEM_GRADED', _count: { _all: 1 } },
        ];
      },
      async findFirst() {
        return { createdAt: new Date('2026-01-01T00:00:00.000Z') };
      },
    },
    async $queryRaw() {
      return [{ count: 0 }];
    },
  };
}

function stubModule(modulePath, exports) {
  const previous = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
  return () => {
    if (previous) require.cache[modulePath] = previous;
    else delete require.cache[modulePath];
  };
}

function loadController(t, queueExports) {
  const restoreDb = stubModule(DB_PATH, makePrismaStub());
  const restoreQueue = stubModule(QUEUE_PATH, queueExports);
  delete require.cache[CONTROLLER_PATH];
  t.after(() => {
    delete require.cache[CONTROLLER_PATH];
    restoreQueue();
    restoreDb();
  });
  return require(CONTROLLER_PATH);
}

async function callHealth(controller) {
  let payload = null;
  const res = {
    status() { return this; },
    json(body) { payload = body; return this; },
  };
  await controller.getAiGradingHealth({}, res);
  return payload;
}

test('health reports real BullMQ waiting+active depth and DB fallback separately', async (t) => {
  const controller = loadController(t, {
    isAiQueueAvailable: () => true,
    getGradingQueue: () => ({
      async getWaitingCount() { return 9; },
      async getActiveCount() { return 4; },
    }),
  });

  const payload = await callHealth(controller);

  assert.equal(payload.success, true);
  assert.equal(typeof payload.data.queueDepth, 'number');
  assert.equal(typeof payload.data.pendingOrRunning, 'number');
  assert.equal(payload.data.pendingOrRunning, 5); // DB: 3 PENDING + 2 RUNNING
  assert.equal(payload.data.queueDepth, 13); // BullMQ: 9 waiting + 4 active
});

test('health falls back to DB count when the queue is unavailable', async (t) => {
  const controller = loadController(t, {
    isAiQueueAvailable: () => false,
    getGradingQueue: () => { throw new Error('must not be called when queue unavailable'); },
  });

  const payload = await callHealth(controller);

  assert.equal(payload.success, true);
  assert.equal(typeof payload.data.queueDepth, 'number');
  assert.equal(typeof payload.data.pendingOrRunning, 'number');
  assert.equal(payload.data.pendingOrRunning, 5);
  assert.equal(payload.data.queueDepth, 5);
});

test('health tolerates a queue read failure and uses the DB fallback', async (t) => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args); };
  t.after(() => { console.warn = originalWarn; });

  const controller = loadController(t, {
    isAiQueueAvailable: () => true,
    getGradingQueue: () => { throw new Error('redis down'); },
  });

  const payload = await callHealth(controller);

  assert.equal(payload.success, true);
  assert.equal(payload.data.pendingOrRunning, 5);
  assert.equal(payload.data.queueDepth, 5);
  assert.equal(warnings.length, 1);
});
