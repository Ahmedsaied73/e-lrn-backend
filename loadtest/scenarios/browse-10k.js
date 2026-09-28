'use strict';

const { SLO, VU_BUDGET, stagesFor } = require('../lib/config.js');
const { cookieFor } = require('../lib/tokens.js');
const { userAction } = require('../lib/behavior.js');

export const options = {
  scenarios: {
    browse: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: VU_BUDGET.preAllocatedVUs,
      maxVUs: VU_BUDGET.maxVUs,
      stages: stagesFor(Number(__ENV.STAGE_CAP) || 0),
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
    'loadtest/results/browse-10k-summary.json': JSON.stringify(data, null, 2),
    stdout: shortSummary(data, 'browse-10k'),
  };
}

function shortSummary(data, name) {
  const m = data.metrics || {};
  const dur = m.http_req_duration && m.http_req_duration['p(95)'];
  return [
    `=== ${name} ===`,
    `http_reqs: ${m.http_reqs ? m.http_reqs.count : '?'}`,
    `p95: ${typeof dur === 'number' ? dur.toFixed(1) : 'n/a'}ms`,
    `req_failed rate: ${m.http_req_failed ? m.http_req_failed.rate.toFixed(4) : 'n/a'}, checks rate: ${m.checks ? m.checks.rate.toFixed(4) : 'n/a'}`,
  ].join('\n');
}
