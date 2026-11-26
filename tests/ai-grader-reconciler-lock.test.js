'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runReconciliationTick } = require('../src/jobs/reconcileAiGrading');

describe('ai reconciler lock contract', () => {
  it('does not reconcile when another instance holds the lock', async () => {
    let reconciled = 0;
    const result = await runReconciliationTick({
      acquire: async () => ({ acquired: false, token: null }),
      release: async () => { throw new Error('must not release a lock we never held'); },
      reconcile: async () => { reconciled += 1; return { ok: true }; },
    });
    assert.deepEqual(result, { skipped: true, reason: 'lock-held' });
    assert.equal(reconciled, 0);
  });

  it('reconciles and releases with the exact token string', async () => {
    const released = [];
    let reconciled = 0;
    const result = await runReconciliationTick({
      acquire: async () => ({ acquired: true, token: 'pid:uuid-123' }),
      release: async (token) => released.push(token),
      reconcile: async () => { reconciled += 1; return { ok: true }; },
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(reconciled, 1);
    assert.deepEqual(released, ['pid:uuid-123']);
  });

  it('does not reconcile when acquisition throws', async () => {
    let reconciled = 0;
    const result = await runReconciliationTick({
      acquire: async () => { throw new Error('redis down'); },
      release: async () => { throw new Error('must not release'); },
      reconcile: async () => { reconciled += 1; return { ok: true }; },
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'lock-held');
    assert.equal(reconciled, 0);
  });

  it('skips an overlapping tick', async () => {
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    const first = runReconciliationTick({
      acquire: async () => ({ acquired: true, token: 't1' }),
      release: async () => {},
      reconcile: async () => gate,
    });
    const second = await runReconciliationTick({
      acquire: async () => { throw new Error('must not acquire twice'); },
      release: async () => {},
      reconcile: async () => ({ ok: true }),
    });
    assert.deepEqual(second, { skipped: true, reason: 'in-progress' });
    releaseGate();
    await first;
  });
});
