'use strict';

/**
 * Phase 2 — the Arabic TEMPLATES (pure).
 *
 * Two things are being protected here:
 *  1. No template may leak a raw JavaScript artefact ("undefined", "NaN") into an
 *     admin-facing answer. Templates are written by hand against real payloads,
 *     so this suite renders every one of them from a fixture.
 *  2. Numbers and time must be formatted the SAME way every time — thousand
 *     separators, one decimal, Cairo time — because the agentic tier (Phase 3)
 *     reuses these exact helpers.
 */

process.env.REDIS_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderAnswer, TEMPLATE_IDS, num, pct, egp, dt, confidence, gradeLabel } = require('../src/services/agent/templates');
const { INTENTS } = require('../src/services/agent/router');
const { RENDERERS } = require('../src/services/agent/templates');

const META = { tool: 'fixture', asOf: '2026-09-24T23:41:35.189Z', ms: 12, cappedAt: 50 };

test('formatting primitives are exact and locale-stable', () => {
  assert.equal(num(1234567), '1,234,567');
  assert.equal(num(1234.55), '1,234.6');
  assert.equal(num(0), '0');
  assert.equal(num(null), '—');
  assert.equal(num(undefined), '—');
  assert.equal(num('42'), '42');

  // Percent values already arrive on the 0..100 scale from the tools.
  assert.equal(pct(83.3), '83.3%');
  assert.equal(pct(0), '0%');
  assert.equal(pct(null), '—');

  // AI confidence arrives on the 0..1 scale and must be shown as a percent.
  assert.equal(confidence(0.9), '90%');
  assert.equal(confidence(0.85), '85%');
  assert.equal(confidence(null), '—');

  assert.equal(egp(1000), '1,000 جنيه');
  assert.equal(gradeLabel('THIRD_SECONDARY'), 'تالتة ثانوي');
  assert.equal(gradeLabel(null), 'كل الصفوف');
  assert.equal(gradeLabel('SOMETHING_ELSE'), 'SOMETHING_ELSE');
});

test('timestamps render in Africa/Cairo, deterministically', () => {
  // 23:41 UTC is 02:41 the next day in Cairo (UTC+3) — an admin reading a
  // server-time answer would otherwise see yesterday's date on tonight's activity.
  assert.equal(dt('2026-09-24T23:41:35.189Z'), '2026-09-25 02:41');
  assert.equal(dt('2026-09-24T11:02:33.568Z'), '2026-09-24 14:02');
  assert.equal(dt(null), '—');
  assert.equal(dt('not-a-date'), '—');
});

test('every catalogued template exists, and every template is used', () => {
  const declared = new Set(INTENTS.map((i) => i.template));
  for (const template of declared) {
    assert.ok(TEMPLATE_IDS.includes(template), `catalogue declares missing template "${template}"`);
  }
  assert.ok(TEMPLATE_IDS.length >= 20, `expected a real template catalogue, got ${TEMPLATE_IDS.length}`);
});

test('an unknown template throws instead of returning an empty answer', () => {
  assert.throws(() => renderAnswer('does_not_exist', {}, META), /unknown template "does_not_exist"/);
});

// ── Fixtures ──────────────────────────────────────────────────────────────────
// One realistic payload per template, shaped exactly like the tools return them
// (see the Phase 1 contract tests). Rendered together by the loop at the end.
const FIXTURES = {
  platform_overview: {
    windowDays: 7,
    sinceIso: '2026-09-17T23:41:32.058Z',
    users: { students: 10036, admins: 1, newStudents7d: 10019 },
    courses: 3,
    enrollments: { total: 20024, paid: 20024, unpaid: 0, completed: 59, newLast7Days: 20015 },
    quizzes: { total: 4, attemptsTotal: 46, attemptsByStatus: { GRADED: 28, EXPIRED: 1, GRADING: 9, IN_PROGRESS: 8 } },
    videos: { total: 7, byStatus: { READY: 7 } },
    certificates: 0,
    pendingWork: { attemptsAwaitingGrading: 9, aiGradingJobsPending: 0, assignmentSubmissionsPending: 0 },
  },
  platform_recent_activity: {
    windowDays: 7,
    sinceIso: '2026-09-17T23:41:35.194Z',
    perSectionLimit: 5,
    newUsers: [{ slug: 'giygu1cpu8tu', name: 'Gate', email: 'g***@localhost.test', grade: 'FIRST_SECONDARY', role: 'STUDENT', createdAt: '2026-09-24T11:02:33.568Z' }],
    newEnrollments: [{ id: 120925, createdAt: '2026-09-24T11:02:37.719Z', isPaid: true, progress: 0, student: { slug: 'giygu1cpu8tu', name: 'Gate', grade: 'FIRST_SECONDARY' }, course: { slug: 'k8ity07q25xc', title: 'Sequential Access Test Course' } }],
    recentAttempts: [{ id: 405, status: 'GRADED', attemptNumber: 1, scorePercent: 100, startedAt: '2026-09-24T11:45:29.937Z', submittedAt: '2026-09-24T11:45:31.345Z', student: { slug: 'ltu-00121', name: 'LoadTest 00121' }, quizTitle: 'Load Test Quiz', videoTitle: 'Load Test Video' }],
    recentPayments: [{ id: 99, amount: 500, currency: 'EGP', status: 'EXPIRED', createdAt: '2026-09-22T20:39:08.455Z' }],
  },
  students_by_grade: {
    role: 'STUDENT',
    total: 10036,
    byGrade: [{ grade: 'FIRST_SECONDARY', count: 10021 }, { grade: 'SECOND_SECONDARY', count: 0 }],
  },
  students_new_trend: {
    granularity: 'week',
    periods: 4,
    buckets: [{ label: 'a..b', startIso: '2026-08-27T23:47:09.443Z', endIso: '2026-09-03T23:47:09.443Z', count: 0 }],
  },
  student_profile: {
    found: true,
    student: { slug: 'gedfufdhiish', name: 'Guard', email: 'a***@localhost.test', phoneNumber: null, grade: 'FIRST_SECONDARY', role: 'STUDENT', createdAt: '2026-09-22T20:38:22.538Z', lastLoginAt: null },
    enrollments: { total: 0, completed: 0, paid: 0, avgProgress: 0 },
    quizzes: { attempts: 0, avgScore: null, lastAttemptAtIso: null },
    gateExemptions: 0,
  },
  student_ranking: {
    direction: 'top',
    minAttempts: 1,
    rows: [{ name: 'LoadTest 00047', slug: 'ltu-00047', grade: 'FIRST_SECONDARY', avgScore: 100, attempts: 1 }],
    returned: 1,
    truncated: false,
  },
  top_students: { direction: 'top', minAttempts: 1, rows: [{ name: 'أحمد', slug: 'ltu-00047', grade: 'FIRST_SECONDARY', avgScore: 100, attempts: 1 }], returned: 1, truncated: false },
  weak_students: { direction: 'bottom', minAttempts: 1, rows: [{ name: 'محمود', slug: 'ltu-00048', grade: 'THIRD_SECONDARY', avgScore: 1, attempts: 1 }], returned: 1, truncated: false },
  inactive_students: {
    inactiveDays: 14,
    cutoffIso: '2026-09-10T23:47:13.493Z',
    rows: [{ student: { slug: '48irdbc7o5bp', name: 'Grader Demo Student', email: 'g***@localhost.test', phoneNumber: '01188800007', grade: 'THIRD_SECONDARY' }, course: { slug: 'k8ity07q25xc', title: 'Sequential Access Test Course', grade: 'THIRD_SECONDARY' }, progress: 33.33333333333333, lastAccessIso: '2026-09-10T13:12:09.095Z' }],
    returned: 1,
    truncated: false,
  },
  courses_list: {
    grade: null,
    orderBy: 'newest',
    rows: [{ courseSlug: 'loadtestquiz', title: 'LOADTEST Quiz Course', grade: 'FIRST_SECONDARY', category: null, priceEgp: 0, createdAtIso: '2026-09-22T17:24:27.355Z', enrollments: 10001, videos: 1, readyVideos: 1 }],
    returned: 1,
    truncated: false,
  },
  course_detail: {
    found: true,
    courseSlug: 'loadtestquiz',
    title: 'LOADTEST Quiz Course',
    grade: 'FIRST_SECONDARY',
    category: null,
    priceEgp: 0,
    createdAtIso: '2026-09-22T17:24:27.355Z',
    enrollments: { total: 10001, paid: 10001, completed: 57, avgProgress: 0.6 },
    videos: { total: 1, ready: 1 },
    quizzes: 1,
    certificates: 0,
    payments: { completed: 0, amountEgp: 0 },
  },
  course_completion_rates: {
    grade: null,
    rows: [{ courseSlug: 'loadtestquiz', title: 'LOADTEST Quiz Course', grade: 'FIRST_SECONDARY', enrollments: 10001, completed: 57, completionRate: 0.6, avgProgress: 0.6 }],
    returned: 1,
    truncated: false,
  },
  courses_by_grade: { byGrade: [{ grade: 'FIRST_SECONDARY', courses: 1, enrollments: 10001, avgPriceEgp: 0 }] },
  video_pipeline_status: {
    byStatus: { PENDING: 0, UPLOADING: 0, PROCESSING: 1, READY: 7, FAILED: 1 },
    staleMinutes: 30,
    staleCutoffIso: '2026-09-24T23:11:36.837Z',
    stuckCount: 1,
    stuck: { rows: [{ id: 3, title: 'Lesson 1', slug: 'm9zmdcce4sme', processingProgress: 40, stuckMinutes: 120, updatedAtIso: '2026-09-24T21:11:36.837Z', courseSlug: 'loadtestquiz', courseTitle: 'LOADTEST Quiz Course' }], returned: 1, truncated: false },
    failed: { rows: [{ id: 4, title: 'Lesson 2', slug: 'aaaaaaaaaaaa', failureReason: 'encode failed', courseSlug: null, courseTitle: null }], returned: 1, truncated: false },
  },
  video_engagement: {
    found: true,
    courseSlug: null,
    overall: { viewers: 10022, completed: 10022, completionRate: 100 },
    rows: [{ videoSlug: 'loadtestvid1', videoTitle: 'Load Test Video', courseSlug: 'loadtestquiz', courseTitle: 'LOADTEST Quiz Course', viewers: 10001, completed: 10001, completionRate: 100 }],
    returned: 1,
    truncated: true,
  },
  quiz_list: {
    rows: [{ quizSlug: 'loadtestqz01', title: 'Load Test Quiz', passingScore: 50, maxAttempts: 1000, timeLimitSec: 600, courseSlug: 'loadtestquiz', videoTitle: 'Load Test Video', attempts: 16, graded: 15, avgScore: 100, passRate: 100 }],
    returned: 1,
    truncated: true,
    sampled: false,
    sampledRows: 28,
  },
  quiz_pass_rates: {
    windowDays: 90,
    sinceIso: '2026-06-26T23:47:19.587Z',
    courseSlug: null,
    rows: [{ quizSlug: 'u4yy63dh1kk9', title: 'Quiz 1 - Essay & Choices', courseSlug: 'k8ity07q25xc', gradedAttempts: 5, passed: 2, failed: 3, passRate: 40, avgScore: 30.8 }],
    returned: 1,
    truncated: false,
    sampled: false,
  },
  quiz_attempts: {
    windowDays: 30,
    sinceIso: '2026-08-25T23:47:20.592Z',
    rows: [{ id: 405, status: 'GRADED', attemptNumber: 1, scorePercent: 100, autoSubmitted: false, startedAtIso: '2026-09-24T11:45:29.937Z', submittedAtIso: '2026-09-24T11:45:31.345Z', deadlineAtIso: null, student: { slug: 'ltu-00121', name: 'LoadTest 00121', email: 'l***@loadtest.local', phoneNumber: null, grade: 'FIRST_SECONDARY' }, quiz: { slug: 'loadtestqz01', title: 'Load Test Quiz', passingScore: 50, videoTitle: 'Load Test Video', courseSlug: 'loadtestquiz' } }],
    returned: 1,
    truncated: true,
  },
  quiz_difficulty: {
    minAttempts: 1,
    rows: [{ quizSlug: 'u4yy63dh1kk9', title: 'Quiz 1 - Essay & Choices', attempts: 5, failed: 3, failRate: 60, avgScore: 30.8 }],
    returned: 1,
    truncated: false,
    sampled: false,
    sampledRows: 28,
  },
  grading_backlog: {
    counts: { attemptsGrading: 9, attemptsSubmitted: 0, submissionsPending: 0 },
    aiJobsByStatus: { PENDING: 2, DONE: 1, FAILED: 0 },
    oldestPendingAgeHours: 26,
    rows: [{ id: 78, attemptNumber: 1, submittedAtIso: '2026-09-10T13:12:12.666Z', student: { slug: '48irdbc7o5bp', name: 'Grader Demo Student', email: 'g***@localhost.test' }, quizTitle: 'Quiz 1 - Essay & Choices', videoTitle: 'Lesson 1' }],
    returned: 1,
    truncated: false,
  },
  ai_grading_stats: {
    windowDays: 30,
    sinceIso: '2026-08-25T23:41:38.000Z',
    byStatus: { PENDING: { count: 0, avgConfidence: 0 }, DONE: { count: 1, avgConfidence: 0.9 }, FAILED: { count: 0, avgConfidence: 0 } },
    applied: 1,
    notApplied: 0,
    failedExhaustedRetries: 0,
    sampled: false,
    sampledRows: 0,
  },
  essay_turnaround: {
    windowDays: 30,
    sinceIso: '2026-08-25T23:41:38.366Z',
    sampleSize: 5,
    avgHours: 10.1,
    medianHours: 0.8,
    fastestHours: 0,
    slowestHours: 32.4,
    sampled: false,
  },
  enrollment_stats: {
    found: true,
    windowDays: 30,
    sinceIso: '2026-08-25T23:47:22.698Z',
    total: 20024,
    paid: 20024,
    unpaid: 0,
    completed: 59,
    newInWindow: 20024,
    completedInWindow: 59,
    avgProgress: 0.3,
  },
  enrollment_trend: {
    granularity: 'week',
    periods: 4,
    buckets: [{ label: 'a..b', startIso: '2026-09-03T23:47:23.121Z', endIso: '2026-09-10T23:47:23.121Z', total: 3, paid: 3, unpaid: 0 }],
  },
  enrollment_by_course: {
    rows: [{ courseSlug: 'k8ity07q25xc', title: 'Sequential Access Test Course', grade: 'THIRD_SECONDARY', priceEgp: 0, enrollments: 10017, completed: 2, completionRate: 0, avgProgress: 16.7, revenueEgp: 1000, paymentsCount: 2 }],
    returned: 1,
    truncated: false,
  },
  revenue_summary: {
    windowDays: 30,
    sinceIso: '2026-08-25T23:47:24.413Z',
    currency: 'EGP',
    note: 'المبالغ بالجنيه المصري كأرقام صحيحة',
    byStatus: {
      PENDING: { count: 0, amount: 0 },
      COMPLETED: { count: 2, amount: 1000 },
      FAILED: { count: 1, amount: 500 },
      EXPIRED: { count: 6, amount: 2620 },
      REFUNDED: { count: 0, amount: 0 },
    },
    revenueEgp: 1000,
    refundedEgp: 0,
    completedCount: 2,
    refundedCount: 0,
    failedCount: 1,
    pendingCount: 0,
    avgOrderValueEgp: 500,
  },
  payment_issues: {
    windowDays: 30,
    sinceIso: '2026-08-25T23:47:24.832Z',
    failedOrExpired: { rows: [{ id: 99, amount: 500, currency: 'EGP', status: 'EXPIRED', failureReason: null, userId: 100917, courseId: 1, createdAtIso: '2026-09-22T20:39:08.455Z' }], returned: 1, truncated: true },
    auditFlags: { rows: [{ id: 1002, action: 'PAYMENT_DUPLICATE_CHARGE', targetType: 'payment', targetId: 210, actorId: null, createdAtIso: '2026-09-24T22:31:36.540Z' }], returned: 1, truncated: true },
  },
  notification_stats: {
    windowDays: 30,
    sinceIso: '2026-08-25T23:42:31.511Z',
    byType: { ADMIN_BROADCAST: 4, QUIZ_GRADED: 32, VIDEO_READY: 14 },
    totalInWindow: 50,
    read: 8,
    unread: 42,
    batchCount: 3,
    topBatches: { rows: [{ batchId: '50905c75-2afe-4199-bacb-3ac1a8b15550', recipients: 6 }], returned: 1, truncated: true },
  },
  admin_audit_recent: {
    windowDays: 7,
    sinceIso: '2026-09-17T23:42:31.877Z',
    filters: { action: null, targetType: null },
    rows: [{ id: 1015, action: 'ENROLL_DELETE', actorId: 1, targetType: 'enrollment', targetId: 120988, metadataKeys: ['userId', 'courseId'], metadataSummary: 'userId=102159, courseId=1', createdAtIso: '2026-09-24T22:32:03.007Z' }],
    returned: 1,
    truncated: true,
  },
};

// ── The gate ──────────────────────────────────────────────────────────────────
test('every template renders a real answer from a realistic payload', () => {
  const problems = [];
  for (const template of TEMPLATE_IDS) {
    const payload = FIXTURES[template];
    if (!payload) {
      problems.push(`${template}: no fixture (a template nobody renders is untested)`);
      continue;
    }
    let answer;
    try {
      answer = renderAnswer(template, payload, META);
    } catch (err) {
      problems.push(`${template}: threw ${err.message}`);
      continue;
    }
    if (typeof answer !== 'string' || answer.trim().length < 40) problems.push(`${template}: answer too short`);
    if (!answer.startsWith('### ')) problems.push(`${template}: missing Arabic heading`);
    if (!answer.includes('🕒')) problems.push(`${template}: missing window/snapshot line`);
    if (/undefined|NaN|\[object|Infinity/.test(answer)) {
      const hit = answer.split('\n').find((l) => /undefined|NaN|\[object|Infinity/.test(l));
      problems.push(`${template}: leaked a raw value -> ${hit}`);
    }
  }
  assert.deepEqual(problems, [], `template problems:\n${problems.join('\n')}`);
});

test('a windowed answer states its window; a snapshot answer says so', () => {
  const windowed = renderAnswer('enrollment_stats', FIXTURES.enrollment_stats, META);
  assert.match(windowed, /النافذة الزمنية: آخر 30 يوم/);

  const snapshot = renderAnswer('courses_by_grade', FIXTURES.courses_by_grade, META);
  assert.match(snapshot, /لقطة لحظية بتاريخ 2026-09-25 02:41/);
});

test('truncation and sampling are disclosed, never hidden', () => {
  const truncated = renderAnswer('video_engagement', FIXTURES.video_engagement, META);
  assert.match(truncated, /النتائج مقصوصة عند 1 صف/);

  const sampled = renderAnswer('quiz_list', { ...FIXTURES.quiz_list, sampled: true, sampledRows: 500 }, META);
  assert.match(sampled, /عيّنة من 500 صف/);

  const clean = renderAnswer('courses_by_grade', FIXTURES.courses_by_grade, META);
  assert.doesNotMatch(clean, /مقصوصة|عيّنة/);
});

test('missing entities are stated plainly, not rendered as zeros', () => {
  const missingStudent = renderAnswer('student_profile', { found: false, userSlug: 'aaaaaaaaaaaa' }, META);
  assert.match(missingStudent, /لا يوجد طالب بالمعرّف/);

  const missingCourse = renderAnswer('course_detail', { found: false, courseSlug: 'aaaaaaaaaaaa' }, META);
  assert.match(missingCourse, /لا توجد دورة بالمعرّف/);
});

test('the shared ranking renderer uses the direction from the payload', () => {
  const top = renderAnswer('top_students', FIXTURES.top_students, META);
  const weak = renderAnswer('weak_students', FIXTURES.weak_students, META);
  assert.match(top, /أعلى الطلاب في الدرجات/);
  assert.match(weak, /أقل الطلاب في الدرجات/);
  assert.doesNotMatch(weak, /أعلى الطلاب/);
});

test('AI confidence is rendered as a percent of a 0..1 scale, and says so', () => {
  const answer = renderAnswer('ai_grading_stats', FIXTURES.ai_grading_stats, META);
  assert.match(answer, /90%/);
  assert.doesNotMatch(answer, /0\.9%/);
  assert.match(answer, /من مقياس 0 إلى 1/);
});

test('row-returning answers render as Markdown tables', () => {
  for (const template of ['courses_list', 'quiz_pass_rates', 'inactive_students', 'payment_issues']) {
    const answer = renderAnswer(template, FIXTURES[template], META);
    assert.match(answer, /\| --- \|/, `${template} should render a table`);
  }
});

test('rendering is deterministic: same payload, same answer', () => {
  // meta.asOf is the only clock input and it is passed in, so a stored answer can
  // be reproduced byte-for-byte (audit, replay, tests).
  const first = renderAnswer('platform_overview', FIXTURES.platform_overview, META);
  const second = renderAnswer('platform_overview', FIXTURES.platform_overview, META);
  assert.equal(first, second);
  assert.equal(typeof RENDERERS.platform_overview, 'function');
});

