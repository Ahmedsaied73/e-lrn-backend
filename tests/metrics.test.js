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
    assert.match(text, /http_request_duration_ms_bucket\{le="250"\} \d+/);
    assert.match(text, /http_request_duration_ms_bucket\{le="\+Inf"\} \d+/);
    assert.match(text, /process_uptime_seconds/);
  });
});
