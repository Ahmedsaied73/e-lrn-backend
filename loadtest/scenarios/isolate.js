'use strict';

/**
 * loadtest/scenarios/isolate.js
 *
 * Per-endpoint isolation ramps to discover each layer's independent ceiling:
 *   1. healthz: Express framework ceiling (0 I/O)
 *   2. courses: Cached query ceiling (Redis / in-memory read)
 *   3. gate: Gate-check ceiling (Redis cached gate verdict)
 *   4. unread: Database read ceiling (Prisma SELECT)
 *   5. progress: Database write ceiling (Prisma UPSERT + cache invalidation)
 *
 * 5 steps of 90s hold after 15s ramp.
 * Usage:
 *   k6 run -e TARGET=healthz loadtest/scenarios/isolate.js
 *   k6 run -e TARGET=courses loadtest/scenarios/isolate.js
 *   k6 run -e TARGET=gate loadtest/scenarios/isolate.js
 *   k6 run -e TARGET=unread loadtest/scenarios/isolate.js
 *   k6 run -e TARGET=progress loadtest/scenarios/isolate.js
 */

const http = require('k6/http');
const { check } = require('k6');
const { BASE_URL } = require('../lib/config.js');
const { cookieFor, slug } = require('../lib/tokens.js');

const TARGET = __ENV.TARGET || __ENV.TARGET_ENDPOINT || 'healthz';

const DEFAULT_STEPS = [200, 500, 1000, 2000, 4000];
const steps = __ENV.STEPS
  ? __ENV.STEPS.split(',').map((s) => Number(s.trim()))
  : DEFAULT_STEPS;

const rampDuration = __ENV.RAMP_TIME || '15s';
const holdDuration = __ENV.HOLD_TIME || '90s';

const stages = [];
for (const target of steps) {
  stages.push({ duration: rampDuration, target });
  stages.push({ duration: holdDuration, target });
}
stages.push({ duration: '15s', target: 0 });

export const options = {
  scenarios: {
    isolate: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: Number(__ENV.PRE_ALLOC_VUS) || 200,
      maxVUs: Number(__ENV.MAX_VUS) || 3000,
      stages,
    },
  },
  thresholds: {
    http_req_failed: [
      { threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '15s' },
      'rate<0.01',
    ],
    http_req_duration: [
      { threshold: 'p(95)<5000', abortOnFail: true, delayAbortEval: '15s' },
      'p(95)<1000',
    ],
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
  const cookie = cookieFor(__VU);
  const headers = { Cookie: cookie };

  switch (TARGET) {
    case 'healthz': {
      const res = http.get(`${BASE_URL}/healthz`, {
        tags: { endpoint: 'healthz', kind: 'framework' },
      });
      checkStatus(res, [200], 'healthz');
      break;
    }

    case 'courses': {
      const res = http.get(`${BASE_URL}/courses/?limit=20&page=1`, {
        headers,
        tags: { endpoint: 'courses_list', kind: 'cached_read' },
      });
      checkStatus(res, [200], 'courses_list');
      break;
    }

    case 'gate': {
      const res = http.get(`${BASE_URL}/videos/${slug('GATE_VIDEO_SLUG')}/playback`, {
        headers,
        tags: { endpoint: 'video_playback', kind: 'gate' },
      });
      checkStatus(
        res,
        (r) => r.status === 200 || (r.status === 403 && r.body && r.body.indexOf('code') !== -1),
        'video_playback'
      );
      break;
    }

    case 'unread': {
      const res = http.get(`${BASE_URL}/notifications/unread-count`, {
        headers,
        tags: { endpoint: 'notifications_unread', kind: 'db_read' },
      });
      checkStatus(res, [200], 'notifications_unread');
      break;
    }

    case 'progress': {
      const res = http.post(
        `${BASE_URL}/progress/complete`,
        JSON.stringify({ videoSlug: slug('LT_VIDEO_SLUG') }),
        {
          headers: { ...headers, 'Content-Type': 'application/json' },
          tags: { endpoint: 'progress_complete', kind: 'db_write' },
        }
      );
      checkStatus(res, [200, 403], 'progress_complete');
      break;
    }

    default:
      throw new Error(`Unknown isolation TARGET: ${TARGET}`);
  }
}
