// tests/metrics.test.js
'use strict';
process.chdir(__dirname + '/..');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { recordRequest, renderPrometheus } = require('../src/metrics/metrics');

describe('metrics module', () => {
  it('renders counters and duration buckets in Prometheus format', () => {
    recordRequest(200, 120);
    recordRequest(500, 3000);
    const text = renderPrometheus();
    assert.match(text, /http_requests_total\{status="200"\} \d+/);
    assert.match(text, /http_requests_total\{status="500"\} \d+/);
    // Bucket values are already cumulative from recordRequest (every bucket
    // with d <= b is incremented), so rendering must NOT re-accumulate.
    // Expected with the two observations (120ms, 3000ms): 250→1, 5000→2.
    const bucketValues = new Map();
    for (const match of text.matchAll(/http_request_duration_ms_bucket\{le="([^"]+)"\} (\d+)/g)) {
      bucketValues.set(match[1], Number(match[2]));
    }
    assert.equal(bucketValues.get('250'), 1);
    assert.equal(bucketValues.get('5000'), 2);
    const infCount = bucketValues.get('+Inf');
    assert.equal(infCount, 2);
    for (const [le, value] of bucketValues) {
      assert.ok(value <= infCount, `bucket le="${le}" (${value}) exceeds +Inf count (${infCount})`);
    }
    assert.match(text, /http_request_duration_ms_count 2/);
    assert.match(text, /process_uptime_seconds/);
  });
});
