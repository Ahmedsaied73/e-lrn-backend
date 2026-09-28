'use strict';

/**
 * Shared user-behavior mix (CommonJS, required by k6 scenarios via require()).
 *
 * Arrival-rate model ("U/10"):
 *   A student acts once every ~5–15s (mean ~10s think time below). One action
 *   fires 1–4 API calls. Therefore an arrival rate of `U/10` iterations/sec
 *   models U *online* users, and the k6 VU pool (arrival × iteration duration)
 *   reproduces the concurrent-herd effect without 10k open connections.
 *
 * THINK TIME: sleep(5 + Math.random()*10) → uniform 5–15s, mean 10s,
 * applied AFTER the requests inside userAction (k6 sleep is allowed in VU code).
 */

const http = require('k6/http');
const { check, sleep } = require('k6');
const { BASE_URL } = require('./config.js');
const { slug } = require('./tokens.js');

// Status check helper: expected = list of tolerable statuses (or a predicate
// on the response). 429 ALWAYS fails — under the LOAD_TEST profile a 429 means
// the rate-limit ceiling is off/too low (documented lesson: stale rl:* buckets
// from a prior run also produce phantom 429s; flush them between stages).
function checkStatus(res, expected, name) {
  check(res, {
    [`${name}: status ok (429 counts as failure)`]: (r) =>
      r.status !== 429 &&
      (typeof expected === 'function' ? expected(r) : expected.indexOf(r.status) !== -1),
  });
}

function browse(headers) {
  const page = 1 + Math.floor(Math.random() * 3);
  const res = http.get(`${BASE_URL}/courses/?limit=20&page=${page}`, {
    headers,
    tags: { kind: 'read', endpoint: 'courses_list' },
  });
  checkStatus(res, [200], 'courses_list');
  if (Math.random() < 0.3) {
    const t = http.get(`${BASE_URL}/search/trending?limit=5`, {
      headers,
      tags: { kind: 'read', endpoint: 'search_trending' },
    });
    checkStatus(t, [200], 'search_trending');
  }
}

function courseDetail(headers) {
  const res = http.get(`${BASE_URL}/courses/${slug('COURSE_SLUG', 'course-1')}`, {
    headers,
    tags: { kind: 'read', endpoint: 'course_detail' },
  });
  checkStatus(res, [200], 'course_detail');
}

function playbackGate(headers) {
  // HOT PATH. 200 passes; a 403 whose body contains "code" is a valid gate
  // denial (structured error envelope) — also passes. Any 500 fails the check.
  const res = http.get(`${BASE_URL}/videos/${slug('GATE_VIDEO_SLUG')}/playback`, {
    headers,
    tags: { kind: 'gate', endpoint: 'video_playback' },
  });
  checkStatus(res, (r) => r.status === 200 || (r.status === 403 && r.body && r.body.indexOf('code') !== -1), 'video_playback');
}

function progressRead(headers) {
  const res = http.get(`${BASE_URL}/progress/course/${slug('COURSE_SLUG', 'course-1')}`, {
    headers,
    tags: { kind: 'read', endpoint: 'progress_read' },
  });
  checkStatus(res, [200], 'progress_read');
}

function progressWrite(headers) {
  const res = http.post(
    `${BASE_URL}/progress/complete`,
    JSON.stringify({ videoSlug: slug('LT_VIDEO_SLUG') }),
    { headers: { ...headers, 'Content-Type': 'application/json' }, tags: { kind: 'write', endpoint: 'progress_complete' } }
  );
  // 200 pass; 403 = sequential gate denial is a valid answer; 500 fails.
  checkStatus(res, [200, 403], 'progress_complete');
}

function quizMeta(headers) {
  const res = http.get(`${BASE_URL}/quizzes/videos/${slug('QUIZ_VIDEO_SLUG')}/meta`, {
    headers,
    tags: { kind: 'read', endpoint: 'quiz_meta' },
  });
  checkStatus(res, [200], 'quiz_meta');
}

function quizFlow(headers) {
  const h = { ...headers, 'Content-Type': 'application/json' };
  const start = http.post(
    `${BASE_URL}/quizzes/videos/${slug('QUIZ_VIDEO_SLUG')}/start`,
    JSON.stringify({}),
    { headers: h, tags: { kind: 'write', endpoint: 'quiz_start' } }
  );
  // 200 starts an attempt; 403 gate / 409 exhausted tolerated on re-runs.
  checkStatus(start, [200, 403, 409], 'quiz_start');
  if (start.status !== 200) return;
  let attemptId;
  try {
    attemptId = start.json().data.attemptId;
  } catch (e) {
    return;
  }
  if (!attemptId) return;
  const submit = http.post(
    `${BASE_URL}/quizzes/attempts/${attemptId}/submit`,
    JSON.stringify({ answers: { q1: 'b', q2: 'b' } }),
    { headers: h, tags: { kind: 'write', endpoint: 'quiz_submit' } }
  );
  // 200 pass; 403 gate / 409 exhausted tolerated; 500 fails.
  checkStatus(submit, [200, 403, 409], 'quiz_submit');
}

/**
 * One simulated student action, weighted by Math.random()*100:
 *   r<35 browse | r<60 course detail | r<80 playback gate (hot) |
 *   r<90 progress read | r<95 progress write | r<99 quiz meta | else quiz flow.
 * Ends with a uniform 5–15s think-time sleep.
 */
function userAction(cookie) {
  const headers = { Cookie: cookie };
  const r = Math.random() * 100;
  if (r < 35) {
    browse(headers);
  } else if (r < 60) {
    courseDetail(headers);
  } else if (r < 80) {
    playbackGate(headers);
  } else if (r < 90) {
    progressRead(headers);
  } else if (r < 95) {
    progressWrite(headers);
  } else if (r < 99) {
    quizMeta(headers);
  } else {
    quizFlow(headers);
  }
  // THINK: uniform 5–15s (mean 10s) → arrival rate U/10 models U online users.
  sleep(5 + Math.random() * 10);
}

module.exports = { userAction };
