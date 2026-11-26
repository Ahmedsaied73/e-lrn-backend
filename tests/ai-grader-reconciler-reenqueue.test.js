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

function baseStubs(t, {
  expired = [], stale = [], unapplied = [], events = null, captured = null, executeRawImpl = null,
  pending = null,
} = {}) {
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
      if (captured) captured.unappliedFindManyArgs = args;
      return unapplied;
    }
    if (
      args.where.status === 'PENDING' &&
      args.where.attemptId !== undefined &&
      args.where.verdict === undefined &&
      args.where.updatedAt === undefined
    ) {
      note('pending:findMany');
      if (captured) captured.pendingFindManyArgs = args;
      return pending === null
        ? [...new Set([...expired, ...stale].map((r) => r.attemptId))].map((attemptId) => ({ attemptId }))
        : pending;
    }
    note('stale:findMany');
    if (captured) captured.staleFindManyArgs = args;
    return stale;
  });

  stub(t, prisma.aiGradingJob, 'updateMany', async (args) => {
    note('expired:updateMany');
    if (captured) captured.updateManyArgs = args;
    return { count: expired.length };
  });

  stub(t, prisma.aiGradingJob, 'update', async () => ({}));
  stub(t, prisma, '$executeRaw', async (strings, ...values) => {
    if (captured) captured.executeRaw = { strings, values };
    return executeRawImpl ? executeRawImpl(strings, values) : 0;
  });
  stub(t, prisma, '$queryRaw', async () => {
    if (captured) captured.queryRawCalls = (captured.queryRawCalls || 0) + 1;
    return [];
  });
}

function whereScopes(captured) {
  return [
    captured.expiredFindManyArgs.where,
    captured.updateManyArgs.where,
    captured.staleFindManyArgs.where,
    captured.unappliedFindManyArgs.where,
  ];
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

  it('does not count an expired lease escalated in the same tick as recovered', async (t) => {
    const captured = {};
    const enqueued = [];
    baseStubs(t, {
      expired: [{ id: 1, attemptId: 101 }],
      // Step 2 escalated job 1 to NEEDS_REVIEW, so it is no longer PENDING.
      pending: [],
      captured,
      executeRawImpl: () => 1,
    });
    stub(t, queue, 'enqueueAiGrading', async (attemptId) => {
      enqueued.push(attemptId);
      return 1;
    });

    const summary = await reconcileAiGrading();

    assert.deepEqual(enqueued, [], 'an escalated lease must not be enqueued');
    assert.equal(summary.exhausted, 1);
    assert.equal(summary.expiredLeases, 1);
    assert.equal(summary.reenqueued, 0);
    assert.equal(summary.reenqueuedLeases, 0, 'an escalated lease must not be reported as recovered');
    assert.deepEqual(captured.pendingFindManyArgs.where, {
      status: 'PENDING',
      attemptId: { in: [101] },
    });
  });
});

describe('ai reconciler attempt scoping and budget deferrals', () => {
  it('scopes every step 1-4 query to attemptIds when provided', async (t) => {
    const captured = {};
    baseStubs(t, { captured });

    await reconcileAiGrading({ attemptIds: [101, 202] });

    for (const where of whereScopes(captured)) {
      assert.deepEqual(where.attemptId, { in: [101, 202] });
    }
    const { strings, values } = captured.executeRaw;
    assert.match(strings.join('?'), /UPDATE "AiGradingJob"/);
    const attemptSql = values.find((v) => v && typeof v.text === 'string' && v.text.includes('attemptId'));
    assert.ok(attemptSql, 'step 2 must compose the attempt filter with Prisma.sql');
    assert.match(attemptSql.text, /"attemptId" IN/);
    assert.deepEqual(attemptSql.values, [101, 202]);
  });

  it('keeps the unfiltered shape when attemptIds is omitted', async (t) => {
    const captured = {};
    baseStubs(t, { captured });

    await reconcileAiGrading();

    for (const where of whereScopes(captured)) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(where, 'attemptId'),
        'the cron tick must not add an attemptId filter'
      );
    }
    const { values } = captured.executeRaw;
    assert.ok(
      !values.some((v) => v && typeof v.text === 'string' && v.text.includes('attemptId')),
      'the cron tick must not add an attempt-id SQL filter'
    );
  });

  it('leaves a spent-tries job with a future nextRunAt PENDING', async (t) => {
    const captured = {};
    const deferred = {
      status: 'PENDING',
      tries: 3,
      maxTries: 3,
      nextRunAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };
    baseStubs(t, {
      captured,
      executeRawImpl(strings, values) {
        const sqlText = `${strings.join(' ')} ${values.map((v) => (v && v.text) || '').join(' ')}`;
        assert.match(sqlText, /"nextRunAt" IS NULL OR "nextRunAt" <=/);
        assert.ok(values[0] instanceof Date, 'the deferral guard must use the tick clock, not DB NOW()');
        // Emulate Postgres applying the WHERE clause to the deferred job.
        const guardPresent = sqlText.includes('"nextRunAt" IS NULL OR "nextRunAt" <=');
        const future = deferred.nextRunAt && deferred.nextRunAt.getTime() > Date.now();
        const matches = deferred.status === 'PENDING'
          && deferred.tries >= deferred.maxTries
          && (!guardPresent || !future);
        return matches ? 1 : 0;
      },
    });

    const summary = await reconcileAiGrading();

    assert.equal(summary.exhausted, 0, 'a budget-deferred job must not be escalated to NEEDS_REVIEW');
  });

  it('skips orphan detection for scoped ticks, keeps it for the cron tick', async (t) => {
    const captured = {};
    baseStubs(t, { captured });

    const scopedSummary = await reconcileAiGrading({ attemptIds: [101] });
    assert.equal(captured.queryRawCalls || 0, 0, 'a scoped tick must not run the global orphan query');
    assert.equal(scopedSummary.orphans, 0);

    const globalSummary = await reconcileAiGrading();
    assert.equal(captured.queryRawCalls, 1, 'the cron tick must still detect orphans');
    assert.equal(globalSummary.orphans, 0);
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
