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
