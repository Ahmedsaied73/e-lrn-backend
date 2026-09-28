'use strict';

const http = require('k6/http');
const { check, sleep } = require('k6');
const { BASE_URL, SLO } = require('../lib/config.js');
const { data, pickUser } = require('../lib/tokens.js');

export const options = {
  scenarios: {
    login_surge: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: 60,
      maxVUs: 300,
      stages: [
        { duration: '1m', target: 3 },
        { duration: '4m', target: 4 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: SLO,
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

// Cohort emails are `ltNNNNN@loadtest.local`; slugs embed the index as
// `ltu-<NNNNN>` (5-digit zero-padded). Derive the email from the slug so we
// stay stateless — pickUser() returns the fixture object only.
function emailFromSlug(slugName) {
  const m = /(\d{5})/.exec(String(slugName || ''));
  const idx = m ? m[1] : '00000';
  return `lt${idx}@loadtest.local`;
}

export default function () {
  const u = pickUser();
  const email = emailFromSlug(u.slug);

  // Per-VU cookie jar: k6 stores the Set-Cookie from login automatically;
  // the subsequent /user/me relies on it (no manual header, no params.jar
  // pollution for the browse scenarios).
  const login = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email, password: data.password }),
    { headers: { 'Content-Type': 'application/json' }, tags: { kind: 'login', endpoint: 'auth_login' } }
  );
  const loginOk = check(login, {
    'login 200': (r) => r.status === 200,
    // Multiple Set-Cookie headers collapse in r.headers — use parsed cookies.
    'accessToken cookie set': (r) => r.cookies && r.cookies.accessToken && r.cookies.accessToken.length > 0,
  });

  const me = http.get(`${BASE_URL}/user/me`, { tags: { kind: 'login', endpoint: 'user_me' } });
  check(me, { 'user/me 200': (r) => r.status === 200 });

  sleep(0.5);
  return loginOk;
}

export function handleSummary(data) {
  return {
    'loadtest/results/login-surge-summary.json': JSON.stringify(data, null, 2),
    stdout: [
      '=== login-surge ===',
      `http_reqs: ${data.metrics.http_reqs ? data.metrics.http_reqs.count : '?'}`,
      `login p95: ${data.metrics['http_req_duration{kind:login}'] && data.metrics['http_req_duration{kind:login}']['p(95)'] !== undefined ? data.metrics['http_req_duration{kind:login}']['p(95)'].toFixed(1) : 'n/a'}ms`,
      `checks rate: ${data.metrics.checks ? data.metrics.checks.rate.toFixed(4) : 'n/a'}`,
    ].join('\n'),
  };
}
