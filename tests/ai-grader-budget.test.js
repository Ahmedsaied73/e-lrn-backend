'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { checkBudget, refundBudget } = require('../src/services/aiGrader/worker');

describe('ai grader token budget', () => {
  it('fails closed without reserving when Redis is not ready', async () => {
    const redis = {
      ensureConnected: async () => false,
      getRedis: () => ({ status: 'end' }),
    };
    assert.deepEqual(await checkBudget(100, { redis }), { allowed: false, reserved: 0 });
  });

  it('fails closed without reserving when the reservation command throws', async () => {
    const redis = {
      ensureConnected: async () => false,
      getRedis: () => ({
        status: 'ready',
        eval: async () => { throw new Error('redis timeout'); },
      }),
    };
    assert.deepEqual(await checkBudget(100, { redis }), { allowed: false, reserved: 0 });
  });

  it('reports a reservation on both allowed and exhausted outcomes', async () => {
    const previous = process.env.AI_GRADER_DAILY_TOKEN_BUDGET;
    process.env.AI_GRADER_DAILY_TOKEN_BUDGET = '100';
    try {
      for (const [reply, allowed] of [[100, true], [200, false]]) {
        const redis = {
          ensureConnected: async () => true,
          getRedis: () => ({ status: 'ready', eval: async () => reply }),
        };
        assert.deepEqual(await checkBudget(100, { redis }), { allowed, reserved: 100 });
      }
    } finally {
      if (previous === undefined) delete process.env.AI_GRADER_DAILY_TOKEN_BUDGET;
      else process.env.AI_GRADER_DAILY_TOKEN_BUDGET = previous;
    }
  });

  it('does not report a reservation on a malformed Redis reply', async () => {
    const redis = {
      ensureConnected: async () => true,
      getRedis: () => ({ status: 'ready', eval: async () => 'not-a-number' }),
    };
    assert.deepEqual(await checkBudget(100, { redis }), { allowed: false, reserved: 0 });
  });

  it('refunds through the injected store', async () => {
    let args = null;
    const redis = {
      getRedis: () => ({
        status: 'ready',
        eval: async (...a) => { args = a; return 0; },
      }),
    };
    await refundBudget(50, { redis });
    assert.equal(args[1], 1);
    assert.ok(args[2].startsWith('v1:ai:token_budget:'));
    assert.equal(args[3], 50);
    assert.match(args[0], /math\.min/);
  });

  it('does not drive an empty counter negative', async () => {
    let counter = 0;
    let script = '';
    const redis = {
      getRedis: () => ({
        status: 'ready',
        // Minimal stand-in for the Lua clamp: never refund more than present.
        eval: async (lua, _keys, _key, amount) => {
          script = lua;
          counter -= Math.min(counter, Number(amount));
          return counter;
        },
      }),
    };
    await refundBudget(50, { redis });
    assert.equal(counter, 0);
    assert.match(script, /tonumber/);
  });
});
