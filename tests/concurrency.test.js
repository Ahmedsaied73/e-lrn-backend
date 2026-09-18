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
    assert.ok(peak === 2, `peak ${peak} must reach exactly the cap 2 (not 1, not more)`);
  });

  it('never exceeds the cap under interleaved arrivals (wake-race)', async () => {
    // Regression: a fresh acquire landing between a release and the woken
    // waiter's resumption used to take the freed slot while the waiter also
    // incremented — transient cap+1. Stagger arrivals across ticks so the
    // release/microtask interleaving actually happens.
    const gate = createSemaphore(2);
    let active = 0, peak = 0;
    const work = () => gate(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return 'ok';
    });
    const launches = [];
    for (let i = 0; i < 20; i++) {
      launches.push(work());
      await new Promise((r) => setImmediate(r)); // fresh arrival in a later tick
    }
    const results = await Promise.all(launches);
    assert.deepStrictEqual(results, Array(20).fill('ok'));
    assert.ok(peak <= 2, `peak ${peak} exceeded cap 2 under interleaved arrivals`);
  });

  it('releases the slot when fn throws', async () => {
    const gate = createSemaphore(1);
    await assert.rejects(() => gate(async () => { throw new Error('boom'); }), /boom/);
    assert.strictEqual(await gate(async () => 'after'), 'after');
  });
});
