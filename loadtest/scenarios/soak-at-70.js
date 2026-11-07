'use strict';

/**
 * loadtest/scenarios/soak-at-70.js
 *
 * 25-minute soak test held at 70% of the measured max sustainable RPS.
 * Catches memory leaks, event-loop drift, connection pool exhaustion,
 * and background Redis latency degradation over sustained traffic.
 *
 * Uses the same weighted traffic distribution as breakpoint.js.
 * Usage:
 *   k6 run -e SUSTAINABLE_RPS=1000 loadtest/scenarios/soak-at-70.js
 */

const http = require('k6/http');
const { check } = require('k6');
const { BASE_URL, SLO } = require('../lib/config.js');
const { cookieFor, slug } = require('../lib/tokens.js');
const { pickEndpoint } = require('../lib/profile.js');

const SUSTAINABLE_RPS = Number(__ENV.SUSTAINABLE_RPS) || 700;
const SOAK_RATE = Number(__ENV.SOAK_RATE) || Math.round(SUSTAINABLE_RPS * 0.7);
const DURATION = __ENV.SOAK_DURATION || '25m';

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: SOAK_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Number(__ENV.PRE_ALLOC_VUS) || 200,
      maxVUs: Number(__ENV.MAX_VUS) || 2000,
    },
  },
  thresholds: {
    ...SLO,
    http_req_failed: [
      { threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '30s' },
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
  const chosen = pickEndpoint();
  const endpoint = chosen.endpoint;
  const cookie = cookieFor(__VU);
  const headers = { Cookie: cookie };

  switch (endpoint) {
    case 'heartbeat': {
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
