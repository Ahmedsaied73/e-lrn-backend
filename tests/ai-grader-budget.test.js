'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { checkBudget, refundBudget } = require('../src/services/aiGrader/worker');

describe('ai grader token budget', () => {
  it('fails closed when Redis is not ready', async () => {
    const redis = {
      ensureConnected: async () => false,
      getRedis: () => ({ status: 'end' }),
    };
    assert.equal(await checkBudget(100, { redis }), false);
  });

  it('fails closed when the reservation command throws', async () => {
    const redis = {
      ensureConnected: async () => false,
      getRedis: () => ({
        status: 'ready',
        eval: async () => { throw new Error('redis timeout'); },
      }),
    };
    assert.equal(await checkBudget(100, { redis }), false);
  });

  it('refunds through the injected store', async () => {
    let args = null;
    const redis = {
      getRedis: () => ({
        status: 'ready',
        decrby: async (...a) => { args = a; },
      }),
    };
    await refundBudget(50, { redis });
    assert.equal(args[1], 50);
  });
});
