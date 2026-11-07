'use strict';

/**
 * loadtest/scenarios/breakpoint.js
 *
 * Open-model stepped breakpoint test. Pushes the API with ramping arrival rate
 * until it breaks, watches latency and errors, and records exact failure points.
 *
 * Invariant: ONE request per iteration chosen by weight, with NO think-time sleep,
 * so RPS strictly equals the configured arrival rate.
 *
 * Steps: 100, 250, 500, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000, 16000 req/s.
 * Each step holds for 3 minutes after a 30-second ramp.
 */

const http = require('k6/http');
const { check } = require('k6');
const { BASE_URL } = require('../lib/config.js');
const { cookieFor, slug } = require('../lib/tokens.js');
const { pickEndpoint } = require('../lib/profile.js');

const RAW_STEPS = [100, 250, 500, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000, 16000];
const cap = Number(__ENV.STAGE_CAP);
const activeSteps = Number.isSafeInteger(cap) && cap > 0
  ? RAW_STEPS.filter((s) => s <= cap).concat(RAW_STEPS.find((s) => s > cap) ? [cap] : [])
  : RAW_STEPS;

const rampDuration = __ENV.RAMP_TIME || '30s';
const holdDuration = __ENV.HOLD_TIME || '3m';

const stages = [];
for (const target of activeSteps) {
  stages.push({ duration: rampDuration, target });
  stages.push({ duration: holdDuration, target });
}
// Recovery drain stage
stages.push({ duration: '30s', target: 0 });

export const options = {
  scenarios: {
    breakpoint: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: Number(__ENV.PRE_ALLOC_VUS) || 300,
      maxVUs: Number(__ENV.MAX_VUS) || 4000,
      stages,
    },
  },
  thresholds: {
    // Hard break: abort if error rate > 5% or p95 > 5000ms
    http_req_failed: [
      { threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '20s' },
      'rate<0.01',
    ],
    http_req_duration: [
      { threshold: 'p(95)<5000', abortOnFail: true, delayAbortEval: '20s' },
      'p(95)<1000',
    ],
    'http_req_duration{kind:gate}': ['p(95)<2000'],
    checks: ['rate>0.99'],
  },
};

function checkStatus(res, expected, name) {
  check(res, {
    [`${name}: status ok (no 429)`]: (r) =>
      r.status !== 429 &&
      (typeof expected === 'function' ? expected(r) : expected.indexOf(r.status) !== -1),
  });
}

export default function () {
  const chosen = pickEndpoint();
  const endpoint = chosen.endpoint;
  const cookie = cookieFor(__VU);
  const headers = { Cookie: cookie };

  switch (endpoint) {
    case 'heartbeat': {
      // Resume/heartbeat stand-in: hits /notifications/unread-count tagged heartbeat_stub
      // until the dedicated Redis resume heartbeat route ships.
      const res = http.get(`${BASE_URL}/notifications/unread-count`, {
        headers,
        tags: { kind: 'heartbeat', endpoint: 'heartbeat_stub' },
      });
      checkStatus(res, [200], 'heartbeat_stub');
      break;
    }

    case 'notifications_unread': {
      const res = http.get(`${BASE_URL}/notifications/unread-count`, {
        headers,
        tags: { kind: 'read', endpoint: 'notifications_unread' },
      });
      checkStatus(res, [200], 'notifications_unread');
      break;
    }

    case 'courses_list': {
      const page = 1 + Math.floor(Math.random() * 3);
      const res = http.get(`${BASE_URL}/courses/?limit=20&page=${page}`, {
        headers,
        tags: { kind: 'read', endpoint: 'courses_list' },
      });
      checkStatus(res, [200], 'courses_list');
      break;
    }

    case 'course_detail': {
      const res = http.get(`${BASE_URL}/courses/${slug('COURSE_SLUG', 'course-1')}`, {
        headers,
        tags: { kind: 'read', endpoint: 'course_detail' },
      });
      checkStatus(res, [200], 'course_detail');
      break;
    }

    case 'video_playback': {
      // Hot path: signed embed playback gate. 200 allowed; 403 with code is a valid gate verdict.
      const res = http.get(`${BASE_URL}/videos/${slug('GATE_VIDEO_SLUG')}/playback`, {
        headers,
        tags: { kind: 'gate', endpoint: 'video_playback' },
      });
      checkStatus(
        res,
        (r) => r.status === 200 || (r.status === 403 && r.body && r.body.indexOf('code') !== -1),
        'video_playback'
      );
      break;
    }

    case 'progress_read': {
      const res = http.get(`${BASE_URL}/progress/course/${slug('COURSE_SLUG', 'course-1')}`, {
        headers,
        tags: { kind: 'read', endpoint: 'progress_read' },
      });
      checkStatus(res, [200], 'progress_read');
      break;
    }

    case 'progress_complete': {
      const res = http.post(
        `${BASE_URL}/progress/complete`,
        JSON.stringify({ videoSlug: slug('LT_VIDEO_SLUG') }),
        {
          headers: { ...headers, 'Content-Type': 'application/json' },
          tags: { kind: 'write', endpoint: 'progress_complete' },
        }
      );
      checkStatus(res, [200, 403], 'progress_complete');
      break;
    }

    case 'quiz_meta': {
      const res = http.get(`${BASE_URL}/quizzes/videos/${slug('QUIZ_VIDEO_SLUG')}/meta`, {
        headers,
        tags: { kind: 'read', endpoint: 'quiz_meta' },
      });
      checkStatus(res, [200], 'quiz_meta');
      break;
    }

    case 'quiz_start': {
      const res = http.post(
        `${BASE_URL}/quizzes/videos/${slug('QUIZ_VIDEO_SLUG')}/start`,
        JSON.stringify({}),
        {
          headers: { ...headers, 'Content-Type': 'application/json' },
          tags: { kind: 'write', endpoint: 'quiz_start' },
        }
      );
      checkStatus(res, [200, 403, 409], 'quiz_start');
      break;
    }

    case 'quiz_submit': {
      const res = http.post(
        `${BASE_URL}/quizzes/attempts/1/submit`,
        JSON.stringify({ answers: { q1: 'b', q2: 'b' } }),
        {
          headers: { ...headers, 'Content-Type': 'application/json' },
          tags: { kind: 'write', endpoint: 'quiz_submit' },
        }
      );
      checkStatus(res, [200, 400, 403, 404, 409], 'quiz_submit');
      break;
    }

    default: {
      const res = http.get(`${BASE_URL}/healthz`, {
        headers,
        tags: { kind: 'read', endpoint: 'healthz' },
      });
      checkStatus(res, [200], 'healthz');
      break;
    }
  }
}
