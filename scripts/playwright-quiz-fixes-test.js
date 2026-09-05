'use strict';

/**
 * Browser verification for the Nov quiz-fix round:
 *  - Bug 6: passing with the LAST allowed attempt shows SUCCESS (not "exhausted")
 *  - Bug 1: intro card shows real totals (بدون / 2 سؤال / 100 درجة) + best-score badge
 *  - Bug 5: no in-progress countdown banner on the intro card
 *  - Bug 3: /me/user/subscriptions shows real enrolled course titles
 *  - Bug 2: new /me/user/achievements page renders totals + per-course cards
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const DB = require('H:/e-learning-platform/src/config/db');
const env = require('H:/e-learning-platform/src/config/env');

const FE = process.env.TARGET_URL || 'http://localhost:3000';
const BE = 'http://localhost:3005';
const ARTIFACT = process.env.PW_ARTIFACT_DIR || path.join(os.tmpdir(), 'pw-quiz-fixes');

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
    name: 'QF ' + slug,
    email: `qfix-${slug}@localhost.test`,
    password: 'Qfix#2026',
    phoneNumber: '011' + slug.slice(0, 3) + '000',
    grade: 'THIRD_SECONDARY',
  };
}

async function browserLogin(browser, student) {
  const ctx = await browser.newContext({ locale: 'ar-EG' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(25000);
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));
  await page.goto(FE + '/login');
  await page.locator('input[name="email"]').waitFor();
  await page.locator('input[name="email"]').fill(student.email);
  await page.locator('input[name="password"]').fill(student.password);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 25000 });
  return { ctx, page };
}

(async () => {
  await waitForBackend();

  const login = async (email, password) => {
    const r = await fetch(BE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const d = await r.json().catch(() => null);
    return { status: r.status, d, cookie: await cookieOf(r) };
  };
  const admin = await login(env.admin.email, env.admin.password);
  if (admin.status !== 200) throw new Error('admin login failed ' + JSON.stringify(admin.d));

  const course = await DB.course.findFirst({ where: { title: 'Sequential Access Test Course' } });
  const videos = await DB.bunnyVideo.findMany({ where: { courseId: course.id }, orderBy: { position: 'asc' } });
  const v1 = videos[0];
  if (!v1) throw new Error('need video 1');

  // ensure quiz on v1: 2 MCQ x 50, passing 60, maxAttempts 3
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
    const en = await DB.enrollment.findFirst({ where: { userId: user.id, courseId: course.id } });
    if (en) await DB.enrollment.update({ where: { id: en.id }, data: { isPaid: true } });
    else await DB.enrollment.create({ data: { userId: user.id, courseId: course.id, isPaid: true, paymentDate: new Date() } });
    if (completeV1) {
      const c = await api('POST', '/progress/complete', { cookie: s.cookie, body: { videoId: v1.id } });
      if (c.status !== 200) throw new Error('complete v1 failed ' + c.status + ' ' + JSON.stringify(c.data));
    }
    return s;
  };

  // ══ Setup Part 1: winlast passes v1 on the 3rd (final) attempt ══
  const winlast = makeStudent('winlast');
  const winSess = await setupStudent(winlast, { completeV1: true });
  async function attemptV1(sess, q1, q2) {
    const st = await api('POST', `/quizzes/videos/${v1.id}/start`, { cookie: sess.cookie, body: {} });
    if (st.status !== 200) throw new Error('start failed ' + st.status + ' ' + JSON.stringify(st.data));
    const sub = await api('POST', `/quizzes/attempts/${st.data.data.attemptId}/submit`, { cookie: sess.cookie, body: { answers: { q1, q2 } } });
    if (sub.status !== 200) throw new Error('submit failed ' + sub.status + ' ' + JSON.stringify(sub.data));
    return sub.data.data;
  }
  await attemptV1(winSess, '3', 'Berlin');          // GRADED 50 (fail 1/3)
  await attemptV1(winSess, '5', 'Rome');            // GRADED 50 (fail 2/3)
  const last = await attemptV1(winSess, '4', 'Paris'); // GRADED 100 (pass 3/3)
  if (last.scorePercent !== 100) throw new Error('expected winlast to pass on attempt 3, got ' + JSON.stringify(last));

  // ══ Setup Part 2: introonly — fresh, no attempts ══
  const introStudent = makeStudent('intro');
  const introSess = await setupStudent(introStudent, { completeV1: true });

  if (!fs.existsSync(ARTIFACT)) fs.mkdirSync(ARTIFACT, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  try {
    // ── Part 1: last-attempt pass shows SUCCESS not exhausted ────────────────
    let { ctx, page } = await browserLogin(browser, winlast);
    await page.goto(FE + `/course/${course.id}/video/${v1.id}/quiz`);
    await page.getByText('Quiz V1 - Basics').waitFor();

    await page.getByText('بدون', { exact: true }).waitFor();
    check('P1 intro shows "بدون" for untimed quiz', true);
    await page.getByText('2 سؤال', { exact: true }).waitFor();
    check('P2 intro shows real question count (2 سؤال)', true);
    await page.getByText('100 درجة', { exact: true }).waitFor();
    check('P3 intro shows real total points (100 درجة)', true);
    await page.getByText('لقد اجتزت هذا الاختبار بنجاح بنسبة 100%').waitFor();
    check('P4 success banner shows on last-attempt pass', true);
    await page.getByRole('button', { name: 'اجتزت الاختبار بنجاح' }).waitFor();
    check('P5 CTA is "اجتزت الاختبار بنجاح" (not انتهت المحاولات)', true);
    const exhausted = await page.getByText(/انتهت المحاولات|استنفدت/).count();
    check('P6 no exhausted/out-of-attempts text on passed-intro', exhausted === 0, `matches=${exhausted}`);
    const badge = await page.getByText('الدرجة الحالية').count();
    check('P7 best-score badge section present (الدرجة الحالية)', badge === 1);
    await page.screenshot({ path: path.join(ARTIFACT, 'winlast-passed-intro.png'), fullPage: true });
    await ctx.close().catch(() => {});

    // ── Part 2: fresh intro — start CTA, no in-progress countdown ────────────
    ({ ctx, page } = await browserLogin(browser, introStudent));
    await page.goto(FE + `/course/${course.id}/video/${v1.id}/quiz`);
    await page.getByRole('button', { name: 'بدء الاختبار الآن' }).waitFor();
    check('P8 fresh intro shows "بدء الاختبار الآن"', true);
    const countdown = await page.getByText(/متبق|متبقى/).count();
    await page.waitForTimeout(800);
    const countdown2 = await page.getByText(/متبق|متبقى/).count();
    check('P9 no in-progress countdown banner on intro', countdown === 0 && countdown2 === 0, `n1=${countdown} n2=${countdown2}`);
    await page.getByText('0 من 3', { exact: true }).waitFor();
    check('P10 attempts tile shows 0 من 3', true);
    await page.screenshot({ path: path.join(ARTIFACT, 'fresh-intro.png'), fullPage: true });
    await ctx.close().catch(() => {});

    // ── Part 3: achievements page (seqquiz has data from the API suite) ──────
    const seq = makeStudent('seqquiz'); // reuse existing suite student creds shape
    const seqReal = { email: 'seqquiz@localhost.test', password: 'SeqQuiz#2026' };
    ({ ctx, page } = await browserLogin(browser, { ...seq, ...seqReal }));
    await page.goto(FE + '/me/user/achievements');
    await page.getByRole('heading', { name: 'انجازاتي' }).waitFor();
    check('P11 achievements page loads with heading انجازاتي', true);
    await page.getByText('كورسات مشترك بها').waitFor();
    check('P12 achievements totals tiles render', true);
    await page.getByText('Sequential Access Test Course').waitFor();
    check('P13 achievements lists the enrolled course', true);
    const passedBadges = await page.getByText('ناجح', { exact: true }).count();
    check('P14 achievements shows at least one ناجح exam badge', passedBadges >= 1, `count=${passedBadges}`);
    const openLinks = await page.getByText('فتح الاختبار').count();
    check('P15 achievements has فتح الاختبار links', openLinks >= 1, `count=${openLinks}`);
    await page.screenshot({ path: path.join(ARTIFACT, 'achievements.png'), fullPage: true });
    await ctx.close().catch(() => {});

    // ── Part 4: subscriptions page shows the real enrolled course ────────────
    ({ ctx, page } = await browserLogin(browser, { ...seq, ...seqReal }));
    await page.goto(FE + '/me/user/subscriptions');
    await page.getByRole('heading', { name: 'الاشتراكات', exact: true }).waitFor();
    await page.getByText('Sequential Access Test Course').waitFor();
    check('P16 subscriptions page lists the real course', true);
    const empty = await page.getByText('لا يوجد اشتراكات حالياً').count();
    check('P17 no empty-subscriptions fallback', empty === 0, `matches=${empty}`);
    await page.screenshot({ path: path.join(ARTIFACT, 'subscriptions.png'), fullPage: true });
    await ctx.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }

  const failed = results.filter((x) => !x.ok);
  console.log('\n========================================');
  if (failed.length) {
    console.log(` QUIZ FIXES BROWSER TEST: ${failed.length}/${results.length} FAILED`);
    failed.forEach((f) => console.log('   ✗ ' + f.name));
    process.exitCode = 1;
  } else {
    console.log(` QUIZ FIXES BROWSER TEST: ALL ${results.length} PASSED ✓`);
    console.log(' screenshots: ' + ARTIFACT);
  }
  console.log('========================================');
  await DB.$disconnect().catch(() => {});
})().catch((e) => { console.error('BROWSER ERROR:', e); process.exitCode = 1; });