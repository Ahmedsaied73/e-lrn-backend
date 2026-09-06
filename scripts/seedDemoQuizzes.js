'use strict';

/**
 * P3 (T3.8): seed quizzes + a GRADING attempt on the demo course (#8).
 *
 * Creates a quiz per demo video (v1 = essay quiz, v2/v3 = MCQ), gifts the
 * seq-access student pre-passed GRADED attempts on v1/v2 so the 10/10
 * sequential-access suite in uploadDemoVideos.js stays green, and leaves one
 * GRADING essay attempt (a fresh demo student) that the admin can grade in
 * the new /admin/grading inbox.
 *
 * Run order after seeding: `node scripts/uploadDemoVideos.js` should still
 * report ALL 10 PASSED.
 */

const prisma = require('../src/config/db');
const BASE_URL = 'http://localhost:3005';

const COURSE_TITLE = process.env.SEQ_COURSE_TITLE || 'Sequential Access Test Course';
const SEQ_STUDENT = {
  name: 'Seq Access Tester',
  email: process.env.SEQ_EMAIL || 'seqaccess@localhost.test',
  password: process.env.SEQ_PASSWORD || 'SeqAccess#2026',
  phoneNumber: '01098765432',
  grade: 'THIRD_SECONDARY',
};
const GRADER_STUDENT = {
  name: 'Grader Demo Student',
  email: 'grader-demo@localhost.test',
  password: 'GraderDemo#2026',
  phoneNumber: '01188800007',
  grade: 'THIRD_SECONDARY',
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
      if (res.status === 200 || res.status === 404) return;
    } catch (e) {}
    await sleep(1500);
  }
  throw new Error('Server did not respond. Start it with: npm run dev');
}

async function api(pathname, { cookie, method = 'GET', body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE_URL}${pathname}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
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

async function ensureStudent(profile) {
  let sess = await loginAs(profile.email, profile.password);
  if (sess.status !== 200) {
    const reg = await api('/auth/register', { method: 'POST', body: profile });
    if (![200, 201].includes(reg.status)) throw new Error(`register ${profile.email} failed: ${JSON.stringify(reg.data)}`);
    sess = await loginAs(profile.email, profile.password);
  }
  if (sess.status !== 200) throw new Error(`login ${profile.email} failed: ${JSON.stringify(sess.data)}`);
  return sess;
}

async function main() {
  await waitForServer();

  const admin = await loginAs(process.env.ADMIN_EMAIL || 'admin@elearning.com', process.env.ADMIN_PASSWORD || 'admin123');
  if (admin.status !== 200) throw new Error('admin login failed');
  const adminCookie = admin.cookie;

  const course = await prisma.course.findFirst({ where: { title: COURSE_TITLE } });
  if (!course) throw new Error('Demo course missing — run scripts/uploadDemoVideos.js first.');
  const videos = await prisma.bunnyVideo.findMany({ where: { courseId: course.id }, orderBy: { position: 'asc' } });
  if (videos.length < 3) throw new Error('Demo course needs at least 3 videos.');
  const [v1, v2, v3] = videos;
  console.log(`Demo course #${course.id}: v1=#${v1.id} v2=#${v2.id} v3=#${v3.id}`);

  const seqUser = await prisma.user.findUnique({ where: { email: SEQ_STUDENT.email } });
  const graderUser = await prisma.user.findUnique({ where: { email: GRADER_STUDENT.email } });

  // ── Reset precondition state for both students (fresh gate state) ────────
  for (const u of [seqUser, graderUser]) {
    if (!u) continue;
    await prisma.quizAttempt.deleteMany({ where: { userId: u.id, quiz: { bunnyVideo: { courseId: course.id } } } });
    await prisma.bunnyVideoProgress.deleteMany({ where: { userId: u.id, bunnyVideo: { courseId: course.id } } });
    await prisma.enrollment.deleteMany({ where: { userId: u.id, courseId: course.id } });
  }
  console.log('Reset progress/attempts/enrollments for demo students.');

  // ── Create quizzes ────────────────────────────────────────────────────────
  const surveys = {
    [v1.id]: {
      title: 'Quiz 1 - Essay & Choices', passingScore: 50,
      surveyJson: { pages: [{ elements: [
        { type: 'radiogroup', name: 'q1', title: 'ما حاصل 2 + 2؟', choices: ['3', '4', '5'] },
        { type: 'comment', name: 'essay1', title: 'اشرح اختيارك باختصار' },
      ] }] },
      answerKey: { q1: { type: 'radiogroup', correctValue: '4', points: 50 }, essay1: { type: 'comment', modelAnswer: 'الإجابة الصحيحة هي 4', points: 50 } },
    },
    [v2.id]: {
      title: 'Quiz 2 - Basics', passingScore: 50,
      surveyJson: { pages: [{ elements: [
        { type: 'radiogroup', name: 'q1', title: 'عاصمة مصر؟', choices: ['القاهرة', 'الإسكندرية', 'أسوان'] },
      ] }] },
      answerKey: { q1: { type: 'radiogroup', correctValue: 'القاهرة', points: 100 } },
    },
    [v3.id]: {
      title: 'Quiz 3 - Review', passingScore: 60,
      surveyJson: { pages: [{ elements: [
        { type: 'radiogroup', name: 'q1', title: 'كم عدد الكواكب؟', choices: ['7', '8', '9'] },
      ] }] },
      answerKey: { q1: { type: 'radiogroup', correctValue: '8', points: 100 } },
    },
  };

  for (const vId of [v1.id, v2.id, v3.id]) {
    const s = surveys[vId];
    const r = await api(`/quizzes/videos/${vId}`, { method: 'POST', cookie: adminCookie, body: { title: s.title, passingScore: s.passingScore, timeLimitSec: null, maxAttempts: 3, surveyJson: s.surveyJson, answerKey: s.answerKey } });
    if (!r.data?.success) throw new Error(`quiz create on video ${vId} failed: ${JSON.stringify(r.data)}`);
    console.log(`Quiz "${s.title}" → video #${vId} (quiz id ${r.data.data.id})`);
  }

  // ── Re-enroll both students ───────────────────────────────────────────────
  for (const u of [seqUser, graderUser]) {
    if (!u) continue;
    await prisma.enrollment.create({ data: { userId: u.id, courseId: course.id, isPaid: true, paymentDate: new Date() } });
  }
  console.log('Enrolled demo students (isPaid).');

  // ── Gift seq-access student pre-passed GRADED attempts on v1/v2 quizzes ──
  const qV1 = await prisma.quiz.findUnique({ where: { bunnyVideoId: v1.id } });
  const qV2 = await prisma.quiz.findUnique({ where: { bunnyVideoId: v2.id } });
  for (const [quiz, correct] of [[qV1, 1], [qV2, 1]]) {
    await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId: seqUser.id,
        attemptNumber: 1,
        status: 'GRADED',
        startedAt: new Date(),
        submittedAt: new Date(),
        responses: { q1: correct ? '4' : '3' },
        mcqEarned: 100,
        essayEarned: 0,
        totalPoints: 100,
        earnedPoints: 100,
        scorePercent: 100,
      },
    });
  }
  console.log(`Pre-passed GRADED attempts inserted for ${SEQ_STUDENT.email} on quizzes id ${qV1.id}, ${qV2.id}.`);

  // ── Grader demo student: complete v1 + take the essay quiz → GRADING ─────
  const graderExisted = !!graderUser;
  const graderSession = await ensureStudent(GRADER_STUDENT);
  if (!graderExisted) {
    const fresh = await prisma.user.findUnique({ where: { email: GRADER_STUDENT.email } });
    await prisma.enrollment.create({ data: { userId: fresh.id, courseId: course.id, isPaid: true, paymentDate: new Date() } });
    console.log(`Enrolled ${GRADER_STUDENT.email} in course #${course.id}.`);
  }

  const comp = await api('/progress/complete', { method: 'POST', cookie: graderSession.cookie, body: { videoId: v1.id } });
  if (comp.status !== 200) throw new Error(`grader-demo complete v1 failed: ${comp.status} ${JSON.stringify(comp.data)}`);
  const start = await api(`/quizzes/videos/${v1.id}/start`, { method: 'POST', cookie: graderSession.cookie, body: {} });
  const attemptId = start.data?.data?.attemptId;
  if (!attemptId) throw new Error(`grader-demo start failed: ${JSON.stringify(start.data)}`);
  const submit = await api(`/quizzes/attempts/${attemptId}/submit`, { method: 'POST', cookie: graderSession.cookie, body: { answers: { q1: '4', essay1: 'أعتقد أن الإجابة هي 4 لأن 2+2=4' } } });
  if (!submit.data?.success || submit.data?.data?.status !== 'GRADING') {
    throw new Error(`grader-demo submit failed: ${JSON.stringify(submit.data)}`);
  }
  console.log(`GRADING attempt #${attemptId} left for ${GRADER_STUDENT.email} on quiz "${qV1.title}".`);

  console.log('\nSeed complete. Next: run `node scripts/uploadDemoVideos.js` to confirm the 10/10 suite;');
  console.log('then open /admin/grading in the console to grade the pending essay.');
}

main()
  .catch((err) => { console.error('\nSeed error:', err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect().catch(() => {}); });