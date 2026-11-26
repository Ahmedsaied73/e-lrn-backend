'use strict';

/**
 * Unit tests for the reconciler's expired-lease recovery and its atomic
 * verdict-retry path. Prisma / BullMQ / quizService are stubbed at their
 * module boundaries, so these tests need no database and no Redis.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const prisma = require('../src/config/db');
const config = require('../src/config/env');
const quizService = require('../src/services/quizService');
const queue = require('../src/services/aiGrader/queue');
const { reconcileAiGrading } = require('../src/jobs/reconcileAiGrading');

function stub(t, object, name, implementation) {
  const hadOwn = Object.prototype.hasOwnProperty.call(object, name);
  const original = object[name];
  object[name] = implementation;
  t.after(() => {
    if (hadOwn) object[name] = original;
    else delete object[name];
  });
}

function baseStubs(t, { expired = [], stale = [], unapplied = [], events = null, captured = null } = {}) {
  const note = (event) => { if (events) events.push(event); };

  stub(t, config.features, 'aiGrader', true);

  stub(t, prisma.aiGradingJob, 'findMany', async (args) => {
    if (args.where.status === 'RUNNING') {
      note('expired:findMany');
      if (captured) captured.expiredFindManyArgs = args;
      return expired;
    }
    if (args.where.verdict !== undefined) {
      note('unapplied:findMany');
      return unapplied;
    }
    note('stale:findMany');
    return stale;
  });

  stub(t, prisma.aiGradingJob, 'updateMany', async (args) => {
    note('expired:updateMany');
    if (captured) captured.updateManyArgs = args;
    return { count: expired.length };
  });

  stub(t, prisma.aiGradingJob, 'update', async () => ({}));
  stub(t, prisma, '$executeRaw', async () => 0);
  stub(t, prisma, '$queryRaw', async () => []);
}

describe('ai reconciler expired leases', () => {
  it('re-enqueues expired leases in the same tick, deduped with stale pending', async (t) => {
    const events = [];
    const enqueued = [];
    baseStubs(t, {
      expired: [{ id: 1, attemptId: 101 }, { id: 2, attemptId: 102 }],
      stale: [{ attemptId: 102 }, { attemptId: 103 }],
      events,
    });
    stub(t, queue, 'enqueueAiGrading', async (attemptId, options) => {
      enqueued.push([attemptId, options]);
      return 1;
    });

    const summary = await reconcileAiGrading();

    assert.equal(summary.expiredLeases, 2);
    assert.equal(summary.reenqueuedLeases, 2);
    assert.equal(summary.reenqueued, 3);
    assert.deepEqual(enqueued, [
      [101, { freshJobIds: true }],
      [102, { freshJobIds: true }],
      [103, { freshJobIds: true }],
    ]);

    // IDs must be collected before the RUNNING -> PENDING reset.
    assert.ok(
      events.indexOf('expired:findMany') < events.indexOf('expired:updateMany'),
      'expired attempt IDs must be collected before resetting the leases'
    );
  });

  it('does not reset expired rows beyond the collected page', async (t) => {
    const captured = {};
    const enqueued = [];
    // Rows 1 and 2 are returned by the capped findMany; row 51 is also expired
    // in the DB but beyond the page, so this tick must leave it RUNNING.
    const firstPage = [{ id: 1, attemptId: 101 }, { id: 2, attemptId: 102 }];
    baseStubs(t, { expired: firstPage, captured });
    stub(t, queue, 'enqueueAiGrading', async (attemptId) => {
      enqueued.push(attemptId);
      return 1;
    });

    const summary = await reconcileAiGrading();

    const findArgs = captured.expiredFindManyArgs;
    assert.equal(findArgs.select.id, true, 'select must include job id');
    assert.equal(findArgs.select.attemptId, true);
    assert.deepEqual(findArgs.distinct, ['attemptId']);
    assert.equal(findArgs.take, 50);

    const updateArgs = captured.updateManyArgs;
    assert.ok(updateArgs, 'updateMany must be called');
    assert.deepEqual(updateArgs.where.id.in, [1, 2]);
    assert.ok(!updateArgs.where.id.in.includes(51), 'unreturned job 51 must stay RUNNING');
    assert.equal(updateArgs.where.status, 'RUNNING');
    assert.ok(updateArgs.where.leaseUntil.lt instanceof Date);
    assert.equal(updateArgs.data.status, 'PENDING');
    assert.equal(updateArgs.data.leaseUntil, null);
    assert.ok(updateArgs.data.nextRunAt instanceof Date);

    assert.deepEqual(enqueued, [101, 102], 'only collected attempts are re-enqueued');
    assert.equal(summary.expiredLeases, 2);
    assert.equal(summary.reenqueuedLeases, 2);
  });
});

describe('ai reconciler atomic verdict retry', () => {
  const verdict = {
    score: 8,
    maxScore: 10,
    feedback: 'ok',
    confidence: 0.9,
    model: 'model-under-test',
    promptVersion: 'v1',
  };
  const job = { id: 77, attemptId: 101, questionName: 'q_ai', verdict };

  function makeTx(events) {
    return {
      aiGradingJob: {
        update: async (args) => {
          events.push('tx:jobUpdate');
          assert.equal(args.where.id, 77);
          assert.equal(args.data.status, 'DONE_APPLIED');
          assert.equal(args.data.applied, true);
          assert.equal(args.data.leaseUntil, null);
          return {};
        },
      },
    };
  }

  it('applies the verdict and the job transition in one transaction, then finalizes', async (t) => {
    const events = [];
    const tx = makeTx(events);
    baseStubs(t, { unapplied: [job], events });

    stub(t, prisma, '$transaction', async (fn) => {
      events.push('tx:begin');
      const out = await fn(tx);
      events.push('tx:commit');
      return out;
    });
    stub(t, quizService, 'applyAiVerdictInTx', async (gotTx, attemptId, qName, appliedVerdict) => {
      events.push('apply');
      assert.equal(gotTx, tx);
      assert.equal(attemptId, 101);
      assert.equal(qName, 'q_ai');
      assert.deepEqual(appliedVerdict, {
        awarded: 8,
        max: 10,
        feedback: 'ok',
        confidence: 0.9,
        model: 'model-under-test',
        promptVersion: 'v1',
      });
      return { finalized: true, userId: 55 };
    });
    stub(t, quizService, 'postFinalize', async (attemptId, userId) => {
      events.push('postFinalize');
      assert.equal(attemptId, 101);
      assert.equal(userId, 55);
    });

    const summary = await reconcileAiGrading();

    assert.equal(summary.retriedApply, 1);
    const at = (name) => events.indexOf(name);
    assert.ok(at('tx:begin') < at('apply'), 'apply must run inside the transaction');
    assert.ok(at('apply') < at('tx:jobUpdate'), 'job update must follow the verdict');
    assert.ok(at('tx:jobUpdate') < at('tx:commit'), 'job update must commit with the verdict');
    assert.ok(at('tx:commit') < at('postFinalize'), 'finalize only after commit');
  });

  it('leaves the job unchanged and does not finalize when application fails', async (t) => {
    const events = [];
    const tx = makeTx(events);
    baseStubs(t, { unapplied: [job], events });

    stub(t, prisma, '$transaction', async (fn) => {
      events.push('tx:begin');
      try {
        return await fn(tx);
      } finally {
        events.push('tx:rollback');
      }
    });
    stub(t, quizService, 'applyAiVerdictInTx', async () => {
      events.push('apply');
      throw new Error('injected application failure');
    });
    stub(t, quizService, 'postFinalize', async () => { events.push('postFinalize'); });

    const summary = await reconcileAiGrading();

    assert.equal(summary.retriedApply, 0);
    assert.ok(!events.includes('tx:jobUpdate'), 'a failed apply must not mark the job applied');
    assert.ok(!events.includes('postFinalize'), 'a failed apply must not finalize the attempt');
  });
});
