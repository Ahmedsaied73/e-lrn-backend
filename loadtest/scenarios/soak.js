'use strict';

const { SLO } = require('../lib/config.js');
const { cookieFor } = require('../lib/tokens.js');
const { userAction } = require('../lib/behavior.js');

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.SOAK_RATE) || 120, // 120/s ≈ 1200 online (generator ceiling)
      timeUnit: '1s',
      duration: __ENV.SOAK_DURATION || '45m',
      preAllocatedVUs: 300,
      maxVUs: 1500,
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
    'loadtest/results/soak-summary.json': JSON.stringify(data, null, 2),
    stdout: shortSummary(data, 'soak'),
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
