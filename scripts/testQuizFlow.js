'use strict';

/**
 * Quiz + gate integration test (Phase A/B of plans/quiz-test-plan.md)
 *
 * Runs against live backend http://localhost:3005 (round-1 code required).
 * Prerequisites: course #1 "Sequential Access Test Course" with videos 1..3 READY
 * (created by scripts/uploadDemoVideos.js).
 *
 * Coverage:
 *   B1  meta v1: exists, unchecked-out, passed=false
 *   B2  playback v2               → 403 SEQUENTIAL_GATE (nothing done)
 *   B3  complete v1               → 200
 *   B4  playback v2               → still 403 (completion alone does NOT unlock)
 *   B5  start quiz1               → attempt + surveyJson WITHOUT answerKey
 *   B6  submit FAIL (50%)         → GRADED, passed=false
 *   B7  meta v1                   → passed=false, attempted=true
 *   B8  start+submit all-correct  → GRADED, passed=true, 100%
 *   B9  meta v1                   → passed=true
 *   B10 playback v2               → 200  (completion + quiz pass unlocks) ★
 *   B11 result attempt2           → passed, correctAnswer, isCorrect
 *   B12 attempts v1               → 2 attempts, most recent passed
 *   B13 complete v2 → 200; playback v3 → 403 (quiz2 not passed)
 *   B14 upsert essay quiz on v3
 *   B15 start + submit essay      → status=GRADING, hasEssays=true
 *   B16 admin list GRADING queue  → attempt present
 *   B17 admin grade essay         → 200
 *   B18 student result            → GRADED, passed (80>=60), earnedPoints=80
 *   B19 playback v3               → still 403 (quiz2 not passed)
 *   B20 max-attempts: 3 fails on quiz2 → 4th start → 409
 *
 * Re-runnable: existing test student's attempts/progress are wiped first.
 */

const config = require('../src/config/env');
const prisma = require('../src/config/db');

const BASE_URL = 'http://localhost:3005';
const COURSE_TITLE = 'Sequential Access Test Course';
const STUDENT = {
  name: 'Quiz Gate Tester',
  email: 'seqquiz@localhost.test',
  password: 'SeqQuiz#2026',
  phoneNumber: '01097776654',
  grade: 'THIRD_SECONDARY',
};

const MCQ1 = {
  title: 'Quiz V1 - Basics',
  passingScore: 60,
  timeLimitSec: null,
  surveyJson: {
    pages: [{
      elements: [
        { type: 'radiogroup', name: 'q1', title: 'What is 2 + 2?', choices: ['3', '4', '5'] },
        { type: 'radiogroup', name: 'q2', title: 'What is the capital of France?', choices: ['Berlin', 'Paris', 'Rome'] },
      ],
    }],
  },
  answerKey: {
    q1: { type: 'radiogroup', correctValue: '4', points: 50 },
    q2: { type: 'radiogroup', correctValue: 'Paris', points: 50 },
  },
};

const MCQ2 = {
  title: 'Quiz V2 - Geography',
  passingScore: 60,
  timeLimitSec: null,
  maxAttempts: 3,
  surveyJson: {
    pages: [{
      elements: [
        { type: 'radiogroup', name: 'q1', title: 'Capital of Egypt?', choices: ['Luxor', 'Cairo', 'Aswan'] },
        { type: 'radiogroup', name: 'q2', title: 'Longest river?', choices: ['Nile', 'Euphrates'] },
      ],
    }],
  },
  answerKey: {
    q1: { type: 'radiogroup', correctValue: 'Cairo', points: 50 },
    q2: { type: 'radiogroup', correctValue: 'Nile', points: 50 },
  },
};

const ESSAY3 = {
  title: 'Quiz V3 - Essay',
  passingScore: 60,
  timeLimitSec: null,
  surveyJson: {
    pages: [{
      elements: [
        { type: 'comment', name: 'essay1', title: 'Explain how the Nile shaped Egypt', rows: 4 },
      ],
    }],
  },
  answerKey: {
    essay1: { type: 'comment', modelAnswer: 'The Nile provided water, fertile soil, and trade routes for ancient Egypt.', points: 100 },
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractCookies(response) {
  const raw = (typeof response.headers.getSetCookie === 'function' && response.headers.getSetCookie()) || [];
  const single = response.headers.get('set-cookie');
  const all = raw.length ? raw : single ? [single] : [];
  const names = new Set(['accessToken', 'refreshToken']);
  return all
    .map((c) => c.split(';')[0])
    .filter((pair) => names.has(pair.split('=')[0].trim()))
    .join('; ');
}

async function waitForServer() {
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.status === 200 || res.status === 404) return console.log('✓ Backend is up.');
    } catch (e) {}
    await sleep(1500);
  }
  throw new Error(`Backend not reachable at ${BASE_URL}. Start it with: npm run dev`);
}

async function loginAs(email, password) {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data, cookie: extractCookies(res) };
}

async function api(pathname, { cookie, method = 'GET', body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = await res.json(); } catch (e) { parsed = null; }
  return { status: res.status, data: parsed };
}

async function ensureStudent() {
  let sess = await loginAs(STUDENT.email, STUDENT.password);
  if (sess.status !== 200) {
    const reg = await api('/auth/register', {
      method: 'POST',
      body: {
        email: STUDENT.email,
        password: STUDENT.password,
        name: STUDENT.name,
        phoneNumber: STUDENT.phoneNumber,
        grade: STUDENT.grade,
      },
    });
    if (![201, 200].includes(reg.status)) throw new Error(`Student registration failed: ${JSON.stringify(reg.data)}`);
    sess = await loginAs(STUDENT.email, STUDENT.password);
    if (sess.status !== 200) throw new Error(`Student login failed: ${JSON.stringify(sess.data)}`);
  }
  return sess;
}

async function resetStudentState(userId, courseId) {
  await prisma.quizAttempt.deleteMany({ where: { userId } });
  await prisma.bunnyVideoProgress.deleteMany({
    where: { userId, bunnyVideo: { courseId } },
  });
  await prisma.gateExemption.deleteMany({ where: { userId } });
}

async function main() {
  await waitForServer();

  const admin = await loginAs(config.admin.email, config.admin.password);
  if (admin.status !== 200) throw new Error(`Admin login failed: ${JSON.stringify(admin.data)}`);
  const adminCookie = admin.cookie;
  if (!adminCookie) throw new Error('Admin login produced no cookies (cookie-only auth required).');

  // Fixtures: get-or-create course + READY videos
  let course = await prisma.course.findFirst({ where: { title: COURSE_TITLE } });
  if (!course) throw new Error(`Course "${COURSE_TITLE}" not found. Run scripts/uploadDemoVideos.js first.`);
  const list = await api(`/courses/${course.id}/bunny-videos`, { cookie: adminCookie });
  const videos = (list.data?.data || []).sort((a, b) => a.position - b.position);
  if (videos.length < 3 || videos.some((v) => v.status !== 'READY')) {
    throw new Error(`Course #${course.id} needs 3 READY videos. Run scripts/uploadDemoVideos.js first.`);
  }
  const [v1, v2, v3] = videos;
  console.log(`✓ Course #${course.id} with videos #${v1.id}, #${v2.id}, #${v3.id} (READY)`);

  // Fresh student
  const student = await ensureStudent();
  console.log(`✓ Test student (${STUDENT.email}) ready`);
  await resetStudentState((await prisma.user.findUnique({ where: { email: STUDENT.email }, select: { id: true } })).id, course.id);
  console.log('✓ Wiped prior attempts/progress for the test student (re-runnable).');
  const studentUser = await prisma.user.findUnique({ where: { email: STUDENT.email }, select: { id: true } });

  const existing = await prisma.enrollment.findFirst({ where: { userId: studentUser.id, courseId: course.id } });
  if (existing) {
    await prisma.enrollment.update({ where: { id: existing.id }, data: { isPaid: true } });
  } else {
    await prisma.enrollment.create({ data: { userId: studentUser.id, courseId: course.id, isPaid: true, paymentDate: new Date() } });
  }
  console.log('✓ Enrolled + paid test student.');

  const studentCookie = student.cookie;

  // Upsert quizzes (idempotent, updates any prior definition)
  const upsert = (videoId, quiz) => api(`/quizzes/videos/${videoId}`, { method: 'POST', cookie: adminCookie, body: quiz });
  const u1 = await upsert(v1.id, MCQ1);
  const u2 = await upsert(v2.id, MCQ2);
  console.log(`✓ Quiz upserted for v1 (${u1.status}) / v2 (${u2.status})`);
  if (u1.status !== 200 || u2.status !== 200) throw new Error(`Quiz upsert failed: v1=${JSON.stringify(u1.data)} v2=${JSON.stringify(u2.data)}`);

  // ── Assertions ─────────────────────────────────────────────────────────────
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  };
  const d = (r) => r.data?.data;                       // envelope unwrap
  const meta = (id) => api(`/quizzes/videos/${id}/meta`, { cookie: studentCookie });
  const start = (id) => api(`/quizzes/videos/${id}/start`, { method: 'POST', cookie: studentCookie, body: {} });
  const submit = (attemptId, answers) => api(`/quizzes/attempts/${attemptId}/submit`, { method: 'POST', cookie: studentCookie, body: { answers, autoSubmitted: false } });
  const result = (attemptId) => api(`/quizzes/attempts/${attemptId}/result`, { cookie: studentCookie });
  const playback = (id) => api(`/videos/${id}/playback`, { cookie: studentCookie });
  const complete = (id) => api('/progress/complete', { method: 'POST', cookie: studentCookie, body: { videoId: id } });

  // B1
  let m = d(await meta(v1.id));
  check('B1 meta v1 → exists, not passed/attempted, quiz locked on video',
    m && m.exists === true && m.passed === false && m.attempted === false && m.unlocked === false,
    `exists=${m?.exists} unlocked=${m?.unlocked} attempted=${m?.attempted} passed=${m?.passed} bestScore=${m?.bestScore} atMax=${m?.atMaxAttempts}`);

  // B2
  let r = await playback(v2.id);
  check('B2 playback v2 → 403 SEQUENTIAL_GATE (fresh student)',
    r.status === 403 && r.data?.code === 'SEQUENTIAL_GATE', `status=${r.status} code=${r.data?.code}`);

  // B3
  r = await complete(v1.id);
  check('B3 complete v1 → 200', r.status === 200 && r.data?.message === 'Video marked as completed', `status=${r.status}`);

  // B4 — completion alone must NOT unlock the next video
  r = await playback(v2.id);
  check('B4 playback v2 → still 403 (completion alone does not unlock — quiz required)',
    r.status === 403 && r.data?.code === 'SEQUENTIAL_GATE', `status=${r.status} code=${r.data?.code}`);

  // B5 — start attempt, surveyJson must be sanitized (no answerKey leak)
  const s1 = d(await start(v1.id));
  const surveyLeaksKey = Boolean(s1?.quiz?.surveyJson && 'answerKey' in s1.quiz.surveyJson);
  check('B5 start quiz v1 → attempt + sanitized surveyJson (no answerKey)',
    s1 && s1.attemptId > 0 && s1.quiz && !surveyLeaksKey,
    `attemptId=${s1?.attemptId} status=${s1?.status} deadlineAt=${s1?.deadlineAt} answerKeyLeaked=${surveyLeaksKey}`);

  // B6 — deliberate fail (50% < 60%)
  r = await submit(s1.attemptId, { q1: '4', q2: 'Berlin' });
  const sub = d(r);
  check('B6 submit FAIL attempt → GRADED 50%, not passed',
    r.status === 200 && sub?.status === 'GRADED' && sub?.scorePercent === 50 && sub?.hasEssays === false,
    `status=${r.status} attemptStatus=${sub?.status} score=${sub?.scorePercent} hasEssays=${sub?.hasEssays} perQ=${sub?.perQuestion?.length}`);

  // B7
  m = d(await meta(v1.id));
  check('B7 meta v1 → attempted, still not passed, unlocked',
    m && m.attempted === true && m.passed === false && m.unlocked === true && m.bestScore === 50,
    `attempted=${m?.attempted} passed=${m?.passed} unlocked=${m?.unlocked} bestScore=${m?.bestScore} attemptsUsed=${m?.attemptsUsed}`);

  // B8 — retry, all correct → pass
  const s2 = d(await start(v1.id));
  r = await submit(s2.attemptId, { q1: '4', q2: 'Paris' });
  const sub2 = d(r);
  check('B8 submit PASS attempt → GRADED 100%, passed=true',
    r.status === 200 && sub2?.status === 'GRADED' && sub2?.scorePercent === 100,
    `status=${r.status} attemptStatus=${sub2?.status} score=${sub2?.scorePercent} perQ=${sub2?.perQuestion?.length}`);

  // B9
  m = d(await meta(v1.id));
  check('B9 meta v1 → passed=true, bestScore=100',
    m && m.passed === true && m.bestScore === 100, `passed=${m?.passed} bestScore=${m?.bestScore} attemptsUsed=${m?.attemptsUsed}`);

  // B10 — THE money assertion: complete + pass → next video unlocks
  r = await playback(v2.id);
  check('B10 playback v2 → 200 (completion + quiz pass unlock next video) ★',
    r.status === 200, `status=${r.status}${r.data?.data?.playbackUrl ? ' (playbackUrl)' : ''}`);

  // B11 — result shows correct answers
  const res2 = d(await result(s2.attemptId));
  const q1res = res2?.questions?.find((q) => q.name === 'q1');
  const q2res = res2?.questions?.find((q) => q.name === 'q2');
  check('B11 result attempt2 → passed, correctAnswer, isCorrect flags',
    res2 && res2.passed === true && res2.scorePercent === 100 && q1res?.isCorrect === true && q2res?.isCorrect === true && q1res?.correctAnswer === '4',
    `passed=${res2?.passed} score=${res2?.scorePercent} q1=${q1res?.isCorrect}(ans ${q1res?.correctAnswer}) q2=${q2res?.isCorrect}(ans ${q2res?.correctAnswer})`);

  // B12 — attempts list
  const atts = d(await api(`/quizzes/videos/${v1.id}/attempts`, { cookie: studentCookie }));
  const ordered = atts?.attempts && atts.attempts.map((a) => a.attemptNumber);
  const newest = atts?.attempts?.[0];
  check('B12 attempts v1 → 2 attempts, newest = attempt 2, GRADED 100%',
    atts && atts.attempts.length === 2 && newest?.attemptNumber === 2 && newest?.status === 'GRADED' && newest?.scorePercent === 100,
    `attempts=${ordered} newest#${newest?.attemptNumber} status=${newest?.status} score=${newest?.scorePercent}`);

  // B13
  r = await complete(v2.id);
  check('B13a complete v2 → 200', r.status === 200, `status=${r.status}`);
  r = await playback(v3.id);
  check('B13b playback v3 → 403 (quiz2 not passed yet)',
    r.status === 403 && r.data?.code === 'SEQUENTIAL_GATE', `status=${r.status} code=${r.data?.code}`);

  // B14 — pass quiz2 (fail once, then pass) → v3 unlocks
  const t1 = d(await start(v2.id));
  await submit(t1.attemptId, { q1: 'Luxor', q2: 'Euphrates' }); // fail 0%
  const t2 = d(await start(v2.id));
  r = await submit(t2.attemptId, { q1: 'Cairo', q2: 'Nile' });   // pass 100%
  const subB14 = d(r);
  check('B14 pass quiz2 (100%) → GRADED 100',
    r.status === 200 && subB14?.status === 'GRADED' && subB14?.scorePercent === 100,
    `status=${r.status} attemptStatus=${subB14?.status} score=${subB14?.scorePercent}`);
  r = await playback(v3.id);
  check('B14b playback v3 → 200 (quiz2 passed now)',
    r.status === 200, `status=${r.status}`);

  // B15 — complete v3 so its essay quiz can start
  r = await complete(v3.id);
  check('B15 complete v3 → 200', r.status === 200, `status=${r.status}`);

  // ── Phase B: essay + admin grading ─────────────────────────────────────────
  const u3 = await upsert(v3.id, ESSAY3);
  let essayQuizId = u3.data?.data?.id ?? u3.data?.id;
  check('B16 upsert essay quiz on v3', u3.status === 200 && essayQuizId > 0, `status=${u3.status} quizId=${essayQuizId}`);

  const s3 = d(await start(v3.id));
  r = await submit(s3.attemptId, { essay1: 'The Nile provided water, fertile soil, and trade routes for ancient Egypt.' });
  const esub = d(r);
  check('B17 submit essay → GRADING + hasEssays',
    r.status === 200 && esub?.status === 'GRADING' && esub?.hasEssays === true,
    `status=${r.status} attemptStatus=${esub?.status} hasEssays=${esub?.hasEssays} score=${esub?.scorePercent}`);

  const queue = await api(`/quizzes/${essayQuizId}/attempts?status=GRADING`, { cookie: adminCookie });
  const inQueue = Array.isArray(queue.data?.data) && queue.data.data.some((a) => a.id === s3.attemptId && a.status === 'GRADING');
  check('B18 admin GRADING queue contains the essay attempt',
    queue.status === 200 && inQueue, `status=${queue.status} count=${queue.data?.data?.length}`);

  r = await api(`/quizzes/attempts/${s3.attemptId}/grade`, {
    method: 'PUT', cookie: adminCookie,
    body: { essayScores: { essay1: 80 }, essayFeedback: { essay1: 'جيد. أضف تفاصيل عن التجارة.' } },
  });
  check('B19 admin grade essay → 200', r.status === 200 && r.data?.success === true, `status=${r.status} ${JSON.stringify(r.data?.error ?? 'ok')}`);

  const res3 = d(await result(s3.attemptId));
  const eq = res3?.questions?.[0];
  check('B20 student result → GRADED, passed (80≥60), score + feedback',
    res3 && res3.status === 'GRADED' && res3.passed === true && res3.scorePercent === 80 && eq?.earnedPoints === 80 && eq?.feedback === 'جيد. أضف تفاصيل عن التجارة.',
    `status=${res3?.status} passed=${res3?.passed} score=${res3?.scorePercent} earned=${eq?.earnedPoints} feedback=${eq?.feedback}`);

  r = await playback(v3.id);
  check('B20b playback v3 → still 200 (essay failed-to-pass does not regress the gate)',
    r.status === 200, `status=${r.status}`);

  // ── B21: max-attempts retake limiter on quiz2 (2 used → burn 3rd → 4th = 409)
  const t3 = d(await start(v2.id));
  await submit(t3.attemptId, { q1: 'Luxor', q2: 'Euphrates' }); // 3rd attempt used
  const s4 = await start(v2.id);
  check('B21 maxAttempts=3 → 4th start → 409',
    s4.status === 409, `status=${s4.status} body=${JSON.stringify(s4.data)}`);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n========================================');
  const failed = results.filter((x) => !x.ok);
  if (failed.length > 0) {
    console.log(` QUIZ-FLOW TEST RESULT: ${failed.length} FAILED / ${results.length}`);
    failed.forEach((f) => console.log(`   ✗ ${f.name}`));
    process.exit(1);
  }
  console.log(` QUIZ-FLOW TEST RESULT: ALL ${results.length} PASSED ✓`);
  console.log('========================================');
}

main()
  .catch((err) => {
    console.error('\n❌ Execution Error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });