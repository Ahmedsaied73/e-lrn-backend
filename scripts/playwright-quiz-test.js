'use strict';

/**
 * Phase C (quiz-only browser pass).
 * Setup (API): fresh students, enroll, v1 quiz ensured, v1 completed via API.
 * Browser (FE :3000): quiz intro card → locked-for-uncompleted state → start → answer → submit → pass result.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const DB = require('H:/e-learning-platform/src/config/db');

const FE = process.env.TARGET_URL || 'http://localhost:3000';
const BE = 'http://localhost:3005';
const ARTIFACT = process.env.PW_ARTIFACT_DIR || path.join(os.tmpdir(), 'pw-quiz');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cookieOf(res) {
  const raw = (typeof res.headers.getSetCookie === 'function' && res.headers.getSetCookie()) || [];
  const single = res.headers.get('set-cookie');
  const all = raw.length ? raw : single ? [single] : [];
  const names = new Set(['accessToken', 'refreshToken']);
  return all.map((c) => c.split(';')[0]).filter((p) => names.has(p.split('=')[0].trim())).join('; ');
}

async function api(method, p, { cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

async function waitForBackend() {
  for (let i = 0; i < 15; i++) {
    try { const r = await fetch(BE + '/'); if (r.status < 500) return; } catch (e) {}
    await sleep(1500);
  }
  throw new Error('backend not reachable');
}

function makeStudent(slug) {
  return {
    name: 'Quiz Only ' + slug,
    email: `quizonly-${slug}@localhost.test`,
    password: 'QuizOnly#2026',
    phoneNumber: '0109' + slug + '000',
    grade: 'THIRD_SECONDARY',
  };
}

(async () => {
  await waitForBackend();

  const login = async (email, password) => {
    const r = await fetch(BE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const d = await r.json().catch(() => null);
    return { status: r.status, d, cookie: await cookieOf(r) };
  };
  const env = require('H:/e-learning-platform/src/config/env');
  const admin = await login(env.admin.email, env.admin.password);
  if (admin.status !== 200) throw new Error('admin login failed ' + JSON.stringify(admin.d));

  const course = await DB.course.findFirst({ where: { title: 'Sequential Access Test Course' } });
  const videos = await DB.bunnyVideo.findMany({ where: { courseId: course.id }, orderBy: { position: 'asc' } });
  const v1 = videos[0];
  if (!v1) throw new Error('need video 1');

  // ensure quiz on v1
  await api('POST', `/quizzes/videos/${v1.id}`, { cookie: admin.cookie, body: {
    title: 'Quiz V1 - Basics', passingScore: 60, timeLimitSec: null, maxAttempts: 3,
    surveyJson: { pages: [{ elements: [
      { type: 'radiogroup', name: 'q1', title: 'What is 2 + 2?', choices: ['3', '4', '5'] },
      { type: 'radiogroup', name: 'q2', title: 'What is the capital of France?', choices: ['Berlin', 'Paris', 'Rome'] },
    ] }] },
    answerKey: { q1: { type: 'radiogroup', correctValue: '4', points: 50 }, q2: { type: 'radiogroup', correctValue: 'Paris', points: 50 } },
  }});

  const setupStudent = async (st, { completeV1 }) => {
    let s = await login(st.email, st.password);
    if (s.status !== 200) {
      const reg = await api('POST', '/auth/register', { body: st });
      if (![200, 201].includes(reg.status)) throw new Error('register failed ' + JSON.stringify(reg.data));
      s = await login(st.email, st.password);
    }
    const user = await DB.user.findUnique({ where: { email: st.email } });
    await DB.quizAttempt.deleteMany({ where: { userId: user.id } });
    await DB.bunnyVideoProgress.deleteMany({ where: { userId: user.id, bunnyVideo: { courseId: course.id } } });
    await DB.gateExemption.deleteMany({ where: { userId: user.id } });
    const en = await DB.enrollment.findFirst({ where: { userId: user.id, courseId: course.id } });
    if (en) await DB.enrollment.update({ where: { id: en.id }, data: { isPaid: true } });
    else await DB.enrollment.create({ data: { userId: user.id, courseId: course.id, isPaid: true, paymentDate: new Date() } });
    if (completeV1) {
      const c = await api('POST', '/progress/complete', { cookie: s.cookie, body: { videoId: v1.id } });
      if (c.status !== 200) throw new Error('complete v1 failed ' + c.status + ' ' + JSON.stringify(c.data));
    }
    return s;
  };

  const lockedStudent = makeStudent('aaaa');
  const passStudent = makeStudent('bbbb');
  await setupStudent(lockedStudent, { completeV1: false }); // intro card must show locked
  const passSess = await setupStudent(passStudent, { completeV1: true });

  if (!fs.existsSync(ARTIFACT)) fs.mkdirSync(ARTIFACT, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  try {
    // ── Part 1: quiz lock state for the not-completed student ────────────────
    let ctx = await browser.newContext({ locale: 'ar-EG' });
    let page = await ctx.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));
    await page.goto(FE + '/login');
    await page.locator('input[name="email"]').waitFor();
    await page.locator('input[name="email"]').fill(lockedStudent.email);
    await page.locator('input[name="password"]').fill(lockedStudent.password);
    await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
    await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 });

    await page.goto(FE + `/course/${course.id}/video/${v1.id}/quiz`);
    await page.getByText('أكمل الفيديو أولاً لفتح الاختبار').waitFor();
    check('Q1 quiz intro card shows locked for un-completed video', true);
    await page.getByRole('button', { name: 'الاختبار مقفل' }).waitFor();
    check('Q2 start button disabled ("الاختبار مقفل")', true);
    await page.screenshot({ path: path.join(ARTIFACT, 'q1-locked-uncompleted.png'), fullPage: true });
    await ctx.close().catch(() => {});

    // ── Part 2: full quiz pass for the completed student ─────────────────────
    ctx = await browser.newContext({ locale: 'ar-EG' });
    page = await ctx.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));
    await page.goto(FE + '/login');
    await page.locator('input[name="email"]').waitFor();
    await page.locator('input[name="email"]').fill(passStudent.email);
    await page.locator('input[name="password"]').fill(passStudent.password);
    await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
    await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 });

    await page.goto(FE + `/course/${course.id}/video/${v1.id}/quiz`);
    await page.getByText('Quiz V1 - Basics').waitFor();
    await page.getByText('نسبة النجاح').waitFor();
    check('Q3 intro card renders quiz details for unlocked student', true);
    await page.screenshot({ path: path.join(ARTIFACT, 'q2-intro-unlocked.png'), fullPage: true });

    await page.getByRole('button', { name: 'بدء الاختبار الآن' }).click();
    await page.waitForURL(/\/quiz\/run/, { timeout: 20000 });
    check('Q4 quiz runner page opens', true);

    await page.locator('label:has(input[value="4"])').click();
    const q1Checked = await page.locator('input[value="4"]').isChecked();
    await page.getByRole('button', { name: 'السؤال التالي' }).click();
    await page.locator('label:has(input[value="Paris"])').click();
    const q2Checked = await page.locator('input[value="Paris"]').isChecked();
    check('Q5 answers selected for both questions', q1Checked && q2Checked, `q1=${q1Checked} q2=${q2Checked}`);
    await page.screenshot({ path: path.join(ARTIFACT, 'q3-runner-answered.png'), fullPage: true });

    await page.getByRole('button', { name: 'تسليم الامتحان' }).click();
    await page.getByRole('button', { name: 'تسليم الآن' }).click();
    await page.waitForURL(/\/quiz\/result\//, { timeout: 25000 });
    await page.getByText('ناجح ومتميز').waitFor();
    check('Q6 result shows passed state (ناجح ومتميز)', true);
    await page.getByText(/\b100\b/).first().waitFor();
    check('Q7 result shows 100% score', true);
    await page.screenshot({ path: path.join(ARTIFACT, 'q4-result-passed.png'), fullPage: true });
    await ctx.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }

  const failed = results.filter((x) => !x.ok);
  console.log('\n========================================');
  if (failed.length) {
    console.log(` QUIZ BROWSER TEST: ${failed.length}/${results.length} FAILED`);
    failed.forEach((f) => console.log('   ✗ ' + f.name));
    process.exitCode = 1;
  } else {
    console.log(` QUIZ BROWSER TEST: ALL ${results.length} PASSED ✓`);
    console.log(' screenshots: ' + ARTIFACT);
  }
  console.log('========================================');
  await DB.$disconnect().catch(() => {});
})().catch((e) => { console.error('BROWSER ERROR:', e); process.exitCode = 1; });