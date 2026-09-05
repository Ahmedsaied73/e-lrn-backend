'use strict';

/**
 * Sequential-access demo harness.
 *
 * Creates a course with **exactly the first 3 videos**, streams them to
 * Bunny.net, enrolls a dedicated test student, waits until all 3 are READY,
 * then runs the sequential-access assertion suite against the live server:
 *
 *   A1  video 1 playback        → 200            (first video always unlocked)
 *   A2  video 2 playback        → 403 SEQUENTIAL_GATE
 *   A3  video 3 playback        → 403 SEQUENTIAL_GATE
 *   A4  complete video 2        → 403 VIDEO_NOT_UNLOCKED (precondition)
 *   A5  complete video 1        → 200
 *   A6  video 2 playback        → 200            (now unlocked)
 *   A7  complete video 2        → 200
 *   A8  video 3 playback        → 200            (now unlocked)
 *   A9  complete video 3        → 200
 *   A10 course progress         → completedVideos === 3
 *
 * Idempotent: re-running reuses the existing course and skips uploads of
 * videos that are already READY, so it doubles as a status poller + rerun.
 *
 * Env overrides:
 *   SEQ_COURSE_TITLE  — course title (default: "Sequential Access Test Course")
 *   SEQ_WAIT_MINUTES  — max minutes to wait for READY (default: 40)
 *   TEST_VIDEO_FILE   — source clip (reused for every slot when only one exists)
 *   SEQ_EMAIL / SEQ_PASSWORD — test-student credentials (defaults below)
 */

const fs = require('fs');
const path = require('path');
const config = require('../src/config/env');
const prisma = require('../src/config/db');

const BASE_URL = 'http://localhost:3005';

const COURSE_TITLE = process.env.SEQ_COURSE_TITLE || 'Sequential Access Test Course';
const VIDEO_COUNT = 3; // ← "upload just the first 3 vids"
const WAIT_MS = (parseInt(process.env.SEQ_WAIT_MINUTES || '40', 10) || 40) * 60 * 1000;

const DEFAULT_SOURCE = 'C:\\Users\\Ahmed Saied\\Videos\\Clip - Death Note-37-New World (16)-Segment3(00_03_22-00_04_12).wmv 360p.mp4';
const TEST_STUDENT = {
  name: 'Seq Access Tester',
  email: process.env.SEQ_EMAIL || 'seqaccess@localhost.test',
  password: process.env.SEQ_PASSWORD || 'SeqAccess#2026',
  phoneNumber: '01098765432',
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
  console.log(`Connecting to server at ${BASE_URL} ...`);
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.status === 200 || res.status === 404) {
        console.log('✓ Server is ready and responding.');
        return;
      }
    } catch (e) {
      // server is booting up, wait
    }
    await sleep(1500);
  }
  throw new Error('Server did not respond in time. Start it with: npm run dev');
}

async function api(pathname, { cookie, method = 'GET', body, raw } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch (e) {
    parsed = null;
  }
  return { status: res.status, data: parsed };
}

async function uploadToBunny(cookie, videoId, filePath, label) {
  const blob = new Blob([fs.readFileSync(filePath)], { type: 'video/mp4' });
  const form = new FormData();
  form.append('video', blob, path.basename(filePath));
  const res = await fetch(`${BASE_URL}/videos/${videoId}/upload`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form,
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(`Upload failed for ${label}: ${JSON.stringify(data)}`);
  }
  return data.data;
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

async function ensureStudent() {
  let sess = await loginAs(TEST_STUDENT.email, TEST_STUDENT.password);
  if (sess.status === 200) {
    console.log(`✓ Test student exists, logged in (${TEST_STUDENT.email})`);
    return sess;
  }

  const register = await api('/auth/register', {
    method: 'POST',
    body: {
      email: TEST_STUDENT.email,
      password: TEST_STUDENT.password,
      name: TEST_STUDENT.name,
      phoneNumber: TEST_STUDENT.phoneNumber,
      grade: TEST_STUDENT.grade,
    },
  });
  if (![201, 200].includes(register.status)) {
    throw new Error(`Student registration failed: ${JSON.stringify(register.data)}`);
  }

  sess = await loginAs(TEST_STUDENT.email, TEST_STUDENT.password);
  if (sess.status !== 200) throw new Error(`Student login failed: ${JSON.stringify(sess.data)}`);
  console.log(`✓ Created + logged in test student (${TEST_STUDENT.email})`);
  return sess;
}

async function enrollStudent(userId, courseId) {
  const existing = await prisma.enrollment.findFirst({ where: { userId, courseId } });
  if (existing) {
    if (!existing.isPaid) {
      await prisma.enrollment.update({ where: { id: existing.id }, data: { isPaid: true } });
    }
    console.log(`✓ Test student already enrolled in course #${courseId}`);
    return;
  }
  await prisma.enrollment.create({
    data: { userId, courseId, isPaid: true, paymentDate: new Date() },
  });
  console.log(`✓ Enrolled test student in course #${courseId} (isPaid)`);
}

async function main() {
  await waitForServer();

  if (!fs.existsSync(DEFAULT_SOURCE)) {
    throw new Error(`Demo video file not found: ${DEFAULT_SOURCE}\nSet TEST_VIDEO_FILE to a real .mp4 path.`);
  }
  const sourceFile = (process.env.TEST_VIDEO_FILE && fs.existsSync(process.env.TEST_VIDEO_FILE))
    ? process.env.TEST_VIDEO_FILE
    : DEFAULT_SOURCE;
  console.log(`✓ Source clip: ${path.basename(sourceFile)} (${(fs.statSync(sourceFile).size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`  The same clip will fill all ${VIDEO_COUNT} slots to give each lesson a real, playable Bunny video.`);

  // ── Admin session (cookie-only) ──────────────────────────────────────────
  const admin = await loginAs(config.admin.email, config.admin.password);
  if (admin.status !== 200) throw new Error(`Admin login failed: ${JSON.stringify(admin.data)}`);
  const adminCookie = admin.cookie;
  if (!adminCookie) throw new Error('Admin login succeeded but no cookies were returned (cookie-only auth is required).');
  console.log('✓ Admin session cookies acquired.');

  // ── Course (get-or-create) ───────────────────────────────────────────────
  let course = await prisma.course.findFirst({ where: { title: COURSE_TITLE } });
  if (!course) {
    const created = await api('/courses', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        title: COURSE_TITLE,
        description: 'Ordered Bunny lessons used to test the sequential-access gate, unlock precondition, and progress.',
        price: 0,
        grade: TEST_STUDENT.grade,
        thumbnail: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=800',
      },
    });
    if (!created.data?.success) throw new Error(`Course creation failed: ${JSON.stringify(created.data)}`);
    course = created.data.data;
    console.log(`✓ Created course #${course.id} "${COURSE_TITLE}"`);
  } else {
    console.log(`✓ Reusing existing course #${course.id} "${COURSE_TITLE}"`);
  }

  // ── Videos (fill missing slots only) ─────────────────────────────────────
  const existingList = await api(`/courses/${course.id}/bunny-videos`, { cookie: adminCookie });
  const byPosition = new Map((existingList.data?.data || []).map((v) => [v.position, v]));

  const videoIds = {};
  for (let n = 1; n <= VIDEO_COUNT; n++) {
    let video = byPosition.get(n);
    if (video && video.status === 'READY') {
      console.log(`[Lesson ${n}] already READY (BunnyVideo #${video.id}) — skipping upload`);
      videoIds[n] = video.id;
      continue;
    }
    if (!video) {
      const created = await api(`/courses/${course.id}/videos`, {
        method: 'POST',
        cookie: adminCookie,
        body: { title: `Lesson ${n} - ${path.basename(sourceFile)}` },
      });
      if (!created.data?.success) throw new Error(`Video ${n} creation failed: ${JSON.stringify(created.data)}`);
      video = created.data.data;
      videoIds[n] = video.id;
      console.log(`[Lesson ${n}] registered BunnyVideo #${video.id} (GUID ${video.bunnyVideoId})`);
    } else if (video.status === 'FAILED') {
      console.log(`[Lesson ${n}] re-uploading after FAILED state`);
      videoIds[n] = video.id;
    } else {
      videoIds[n] = video.id;
      console.log(`[Lesson ${n}] exists as ${video.status} — upload skipped, will wait`);
      continue;
    }
    const uploaded = await uploadToBunny(adminCookie, video.id, sourceFile, `lesson ${n}`);
    console.log(`[Lesson ${n}] uploaded → ${uploaded.status}`);
  }

  // ── Test student + enrollment ────────────────────────────────────────────
  const student = await ensureStudent();
  const studentCookie = student.cookie;
  const studentUser = await prisma.user.findUnique({ where: { email: TEST_STUDENT.email }, select: { id: true } });
  await enrollStudent(studentUser.id, course.id);

  // ── Wait until all videos are READY ──────────────────────────────────────
  console.log('\nWaiting for Bunny encoding (webhook or reconciliation)...');
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const list = await api(`/courses/${course.id}/bunny-videos`, { cookie: adminCookie });
    const videos = list.data?.data || [];
    const ready = videos.filter((v) => v.status === 'READY');
    const states = videos.map((v) => `${v.position}:${v.status}`).join('  ');
    console.log(`  [${ready.length}/${videos.length} READY] ${states}`);
    if (videos.length >= VIDEO_COUNT && ready.length >= VIDEO_COUNT) break;
    await sleep(10000);
  }

  const finalList = await api(`/courses/${course.id}/bunny-videos`, { cookie: adminCookie });
  const readyVideos = (finalList.data?.data || []).sort((a, b) => a.position - b.position);
  videoIds[1] = readyVideos[0]?.id;
  videoIds[2] = readyVideos[1]?.id;
  videoIds[3] = readyVideos[2]?.id;

  const notReady = readyVideos.filter((v) => v.status !== 'READY');
  if (notReady.length === VIDEO_COUNT || !videoIds[1]) {
    console.error(`\n✗ Videos not READY after ${WAIT_MS / 60000} min. Re-run the script later — it will resume.`);
    process.exit(2);
  }

  console.log('\n=== Courses order check ===');
  readyVideos.forEach((v) => console.log(`  position=${v.position}  id=${v.id}  status=${v.status}  title="${v.title}"`));

  // ── Sequential-access assertion suite ────────────────────────────────────
  console.log('\n=== Sequential-access assertions (student) ===');
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  };

  const playback = (id) => api(`/videos/${id}/playback`, { cookie: studentCookie });
  const complete = (id) => api('/progress/complete', { method: 'POST', cookie: studentCookie, body: { videoId: id } });

  // A1: video 1 (first) → playable
  let r = await playback(videoIds[1]);
  check('A1 video 1 playback → 200', r.status === 200, `status=${r.status}${r.data?.data?.playbackUrl ? ' (playbackUrl present)' : ''}`);

  // A2/A3: videos 2 & 3 blocked before 1 is completed
  r = await playback(videoIds[2]);
  check('A2 video 2 playback → 403 SEQUENTIAL_GATE', r.status === 403 && r.data?.code === 'SEQUENTIAL_GATE',
    `status=${r.status} code=${r.data?.code} previousVideoId=${r.data?.previousVideoId} quizId=${r.data?.quizId}`);

  r = await playback(videoIds[3]);
  check('A3 video 3 playback → 403 SEQUENTIAL_GATE', r.status === 403 && r.data?.code === 'SEQUENTIAL_GATE',
    `status=${r.status} code=${r.data?.code} previousVideoId=${r.data?.previousVideoId}`);

  // A4: unlock precondition — can't complete video 2 out of order
  r = await complete(videoIds[2]);
  check('A4 complete video 2 → 403 VIDEO_NOT_UNLOCKED', r.status === 403 && r.data?.code === 'VIDEO_NOT_UNLOCKED',
    `status=${r.status} code=${r.data?.code} previousVideoId=${r.data?.previousVideoId}`);

  // A5: complete the first video
  r = await complete(videoIds[1]);
  check('A5 complete video 1 → 200', r.status === 200 && r.data?.message === 'Video marked as completed', `status=${r.status}`);

  // A6: video 2 now unlocked
  r = await playback(videoIds[2]);
  check('A6 video 2 playback → 200 (after video 1 done)', r.status === 200, `status=${r.status}`);

  // A7: complete video 2
  r = await complete(videoIds[2]);
  check('A7 complete video 2 → 200', r.status === 200, `status=${r.status}`);

  // A8: video 3 now unlocked
  r = await playback(videoIds[3]);
  check('A8 video 3 playback → 200 (after video 2 done)', r.status === 200, `status=${r.status}`);

  // A9: complete video 3
  r = await complete(videoIds[3]);
  check('A9 complete video 3 → 200', r.status === 200, `status=${r.status}`);

  // A10: course progress is fully complete
  r = await api(`/progress/course/${course.id}`, { cookie: studentCookie });
  const prog = r.data;
  check('A10 course progress completedVideos === 3',
    prog && prog.completedVideos === 3 && prog.totalVideos === 3,
    `totalVideos=${prog?.totalVideos} completedVideos=${prog?.completedVideos}`);

  console.log('\n========================================');
  const failed = results.filter((x) => !x.ok);
  if (failed.length > 0) {
    console.log(` SEQ-ACCESS TEST RESULT: ${failed.length} FAILED / ${results.length}`);
    failed.forEach((f) => console.log(`   ✗ ${f.name}`));
    process.exit(1);
  }
  console.log(` SEQ-ACCESS TEST RESULT: ALL ${results.length} PASSED ✓`);
  console.log('========================================');
  console.log(` Course: ${BASE_URL}/courses/${course.id}`);
  readyVideos.forEach((v) => console.log(`   position=${v.position} → /videos/${v.id}/playback`));
}

main()
  .catch((err) => {
    console.error('\n❌ Execution Error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });