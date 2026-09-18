// tests/concurrency.test.js
'use strict';
process.chdir(__dirname + '/..');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSemaphore } = require('../src/utils/concurrency');

describe('createSemaphore', () => {
  it('caps concurrent executions and preserves return values', async () => {
    const gate = createSemaphore(2);
    let active = 0, peak = 0;
    const work = () => gate(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return 'ok';
    });
    const results = await Promise.all(Array.from({ length: 6 }, work));
    assert.deepStrictEqual(results, Array(6).fill('ok'));
    assert.ok(peak <= 2, `peak ${peak} exceeded cap 2`);
  });

  it('releases the slot when fn throws', async () => {
    const gate = createSemaphore(1);
    await assert.rejects(() => gate(async () => { throw new Error('boom'); }), /boom/);
    assert.strictEqual(await gate(async () => 'after'), 'after');
  });
});
