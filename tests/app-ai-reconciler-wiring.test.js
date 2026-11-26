'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

describe('app.js AI reconciler wiring', () => {
  it('starts the reconciler inside the cron block', () => {
    const cronStart = source.indexOf('if (shouldRunCrons) {');
    const cronEnd = source.indexOf('// ── Graceful shutdown');
    assert.ok(cronStart > -1 && cronEnd > cronStart, 'cron block markers not found');
    const block = source.slice(cronStart, cronEnd);
    assert.match(block, /startAiGradingReconciliationJob\(\)/);
    assert.match(block, /ai\.reconcile\.job_started/);
  });

  it('stops the reconciler in its own try/catch', () => {
    assert.match(
      source,
      /if \(aiGradingReconciliationTask\) \{[\s\S]*?stopAiGradingReconciliationJob\(aiGradingReconciliationTask\)[\s\S]*?\} catch \(err\)/
    );
  });
});
