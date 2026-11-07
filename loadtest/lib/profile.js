'use strict';

/**
 * loadtest/lib/profile.js — student traffic profile and endpoint weighting.
 *
 * Concurrency model:
 * Online students != open HTTP sockets. Students are either watching a video
 * (emitting periodic heartbeats) or browsing/taking quizzes (emitting actions
 * every think-time interval), while background polling checks notifications.
 *
 * Model Formula:
 *   rps_per_student = (WATCHING_RATIO / HEARTBEAT_S)
 *                   + (1 / NOTIF_POLL_S)
 *                   + ((1 - WATCHING_RATIO) * CALLS_PER_ACTION / BROWSE_THINK_S)
 *
 * ASSUMPTIONS (flagged for report):
 * - WATCHING_RATIO default 0.7: 70% of online students are watching video at any moment.
 * - HEARTBEAT_S default 60: video playback heartbeats emit every 60s.
 * - NOTIF_POLL_S default 120: notification unread-count polled every 120s.
 * - BROWSE_THINK_S default 10: active browsing students pause ~10s between page/action clicks.
 * - CALLS_PER_ACTION default 1.0: 1 primary API call per student click.
 */

const env = (typeof __ENV !== 'undefined' ? __ENV : process.env) || {};

function numEnv(key, def) {
  const val = Number(env[key]);
  return Number.isFinite(val) && val > 0 ? val : def;
}

const PROFILE = {
  ONLINE: numEnv('ONLINE', 10000),
  WATCHING_RATIO: env.WATCHING_RATIO !== undefined ? Number(env.WATCHING_RATIO) : 0.7,
  HEARTBEAT_S: numEnv('HEARTBEAT_S', 60),
  NOTIF_POLL_S: numEnv('NOTIF_POLL_S', 120),
  BROWSE_THINK_S: numEnv('BROWSE_THINK_S', 10),
  CALLS_PER_ACTION: numEnv('CALLS_PER_ACTION', 1.0),
};

function computeRpsPerStudent(profile = PROFILE) {
  const watchingRps = profile.WATCHING_RATIO / profile.HEARTBEAT_S;
  const notifRps = 1 / profile.NOTIF_POLL_S;
  const browsingRps = ((1 - profile.WATCHING_RATIO) * profile.CALLS_PER_ACTION) / profile.BROWSE_THINK_S;
  return watchingRps + notifRps + browsingRps;
}

const rpsPerOnlineStudent = computeRpsPerStudent(PROFILE);

function onlineStudentsForRps(rps, profile = PROFILE) {
  const rate = computeRpsPerStudent(profile);
  return rate > 0 ? Math.round(rps / rate) : 0;
}

function rpsForOnlineStudents(online, profile = PROFILE) {
  return online * computeRpsPerStudent(profile);
}

/**
 * Breakdown of endpoint traffic weights:
 * Total rate = heartbeatRate + notifRate + browseRate.
 * Inside browsing (~60% of total under default params):
 *   courses_list (35%), course_detail (25%), playback_gate (20%),
 *   progress_read (10%), progress_complete (5%), quiz_meta (4%),
 *   quiz_start (0.5%), quiz_submit (0.5%).
 */
function computeEndpointWeights(profile = PROFILE) {
  const heartbeatRate = profile.WATCHING_RATIO / profile.HEARTBEAT_S;
  const notifRate = 1 / profile.NOTIF_POLL_S;
  const browseRate = ((1 - profile.WATCHING_RATIO) * profile.CALLS_PER_ACTION) / profile.BROWSE_THINK_S;
  const total = heartbeatRate + notifRate + browseRate;

  return {
    heartbeat: { weight: heartbeatRate / total, kind: 'heartbeat' },
    notifications_unread: { weight: notifRate / total, kind: 'read' },
    courses_list: { weight: (browseRate * 0.35) / total, kind: 'read' },
    course_detail: { weight: (browseRate * 0.25) / total, kind: 'read' },
    video_playback: { weight: (browseRate * 0.20) / total, kind: 'gate' },
    progress_read: { weight: (browseRate * 0.10) / total, kind: 'read' },
    progress_complete: { weight: (browseRate * 0.05) / total, kind: 'write' },
    quiz_meta: { weight: (browseRate * 0.04) / total, kind: 'read' },
    quiz_start: { weight: (browseRate * 0.005) / total, kind: 'write' },
    quiz_submit: { weight: (browseRate * 0.005) / total, kind: 'write' },
  };
}

const ENDPOINT_WEIGHTS = computeEndpointWeights(PROFILE);

// Cumulative distribution array for O(N) random sampling in VU code
const CUMULATIVE_TABLE = [];
let _cum = 0;
for (const [endpoint, info] of Object.entries(ENDPOINT_WEIGHTS)) {
  _cum += info.weight;
  CUMULATIVE_TABLE.push({
    threshold: _cum,
    endpoint,
    kind: info.kind,
    weight: info.weight,
  });
}

function pickEndpoint() {
  const r = Math.random();
  for (let i = 0; i < CUMULATIVE_TABLE.length; i++) {
    if (r <= CUMULATIVE_TABLE[i].threshold) {
      return CUMULATIVE_TABLE[i];
    }
  }
  return CUMULATIVE_TABLE[CUMULATIVE_TABLE.length - 1];
}

/**
 * Sensitivity matrix helper: calculate RPS per student and student capacity
 * across varying watching ratios (e.g. 0.5, 0.7, 0.9) and heartbeat intervals (15s, 30s, 60s).
 */
function sensitivityTable(rpsTarget = 1000) {
  const watchingRatios = [0.5, 0.7, 0.9];
  const heartbeatIntervals = [15, 30, 60];
  const matrix = [];

  for (const w of watchingRatios) {
    for (const h of heartbeatIntervals) {
      const p = { ...PROFILE, WATCHING_RATIO: w, HEARTBEAT_S: h };
      const rpsPerStudent = computeRpsPerStudent(p);
      const studentsAtTarget = Math.round(rpsTarget / rpsPerStudent);
      matrix.push({
        watchingRatio: w,
        heartbeatSeconds: h,
        rpsPerStudent: Number(rpsPerStudent.toFixed(5)),
        studentsAtTargetRps: studentsAtTarget,
      });
    }
  }
  return matrix;
}

module.exports = {
  PROFILE,
  rpsPerOnlineStudent,
  computeRpsPerStudent,
  onlineStudentsForRps,
  rpsForOnlineStudents,
  ENDPOINT_WEIGHTS,
  CUMULATIVE_TABLE,
  pickEndpoint,
  sensitivityTable,
};
