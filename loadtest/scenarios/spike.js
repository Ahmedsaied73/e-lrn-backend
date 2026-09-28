'use strict';

const { SLO } = require('../lib/config.js');
const { cookieFor } = require('../lib/tokens.js');
const { userAction } = require('../lib/behavior.js');

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: 300,
      maxVUs: 1500,
      // Models a 5x surge in 60s, sized to the generator ceiling (~125
      // arrivals/s max — see lib/config.js): 20 → 100 arrivals/s ≈ 200 → 1000
      // online users.
      stages: [
        { duration: '2m', target: 20 },
        { duration: '1m', target: 100 },
        { duration: '2m', target: 100 },
        { duration: '2m', target: 20 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: SLO,
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  userAction(cookieFor(__VU));
}

export function handleSummary(data) {
  return {
    'loadtest/results/spike-summary.json': JSON.stringify(data, null, 2),
    stdout: shortSummary(data, 'spike'),
  };
}

function shortSummary(data, name) {
  const m = data.metrics;
  return [
    `=== ${name} ===`,
    `http_reqs: ${m.http_reqs ? m.http_reqs.count : '?'}`,
    `p95: ${m.http_req_duration && m.http_req_duration['p(95)'] !== undefined ? m.http_req_duration['p(95)'].toFixed(1) : 'n/a'}ms`,
    `req_failed rate: ${m.http_req_failed ? m.http_req_failed.rate.toFixed(4) : 'n/a'}, checks rate: ${m.checks ? m.checks.rate.toFixed(4) : 'n/a'}`,
  ].join('\n');
}
