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

  it('renders extended system and load metrics', () => {
    const {
      recordRouteRequest,
      recordPrismaTimeout,
      recordRedisTimeout,
      metricsMiddleware,
    } = require('../src/metrics/metrics');

    recordRouteRequest('GET', '/courses/:slug');
    recordRouteRequest('POST', '/progress/complete');
    recordPrismaTimeout();
    recordRedisTimeout();

    // Verify metricsMiddleware increments and decrements in-flight, and records routes
    let finishedCallback;
    const req = {
      method: 'GET',
      path: '/videos/123/playback',
      baseUrl: '/videos',
      route: { path: '/:videoId/playback' },
    };
    const res = {
      on: (event, cb) => {
        if (event === 'finish') finishedCallback = cb;
      },
    };
    let nextCalled = false;
    metricsMiddleware(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled);

    let text = renderPrometheus();
    assert.match(text, /http_in_flight_requests 1/);

    finishedCallback();
    text = renderPrometheus();
    assert.match(text, /http_in_flight_requests 0/);
    assert.match(text, /http_requests_by_route_total\{method="GET",route="\/courses\/:slug"\} 1/);
    assert.match(text, /http_requests_by_route_total\{method="POST",route="\/progress\/complete"\} 1/);
    assert.match(text, /http_requests_by_route_total\{method="GET",route="\/videos\/:videoId\/playback"\} 1/);
    assert.match(text, /prisma_pool_timeouts_total 1/);
    assert.match(text, /redis_command_timeouts_total 1/);
    assert.match(text, /nodejs_eventloop_delay_p50_ms \d+/);
    assert.match(text, /nodejs_eventloop_delay_p99_ms \d+/);
    assert.match(text, /nodejs_eventloop_delay_max_ms \d+/);
    assert.match(text, /process_cpu_percent \d+/);
    assert.match(text, /process_resident_memory_bytes \d+/);
    assert.match(text, /process_heap_used_bytes \d+/);
  });
});
