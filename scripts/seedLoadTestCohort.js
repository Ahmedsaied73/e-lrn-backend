'use strict';

/**
 * seedLoadTestCohort.js — seed a synthetic 10,000-user load-test cohort on the
 * STAGING database and pre-generate JWTs for the k6 harness.
 *
 * Usage:
 *   node scripts/seedLoadTestCohort.js [--count 10000]
 *   (count also via LT_COUNT env; default 10000)
 *
 * IDEMPOTENT: every row uses a deterministic key (user email/slug `lt00001@loadtest.local`,
 * course slug `loadtest-quiz`, video slug `loadtest-quiz-v1`, quiz by bunnyVideoId,
 * enrollments/progress via createMany skipDuplicates). Re-running only tops up missing rows.
 *
 * STAGING-ONLY: refuses to run with NODE_ENV=production. Verify the target by the
 * printed DATABASE_URL hostname before executing.
 *
 * Output: loadtest/.tokens.json — consumed by the k6 harness.
 * Run the target server with LOAD_TEST=true so the load-test paths are active.
 */

process.chdir(__dirname + '/..');
require('dotenv').config(); // .env must be loaded before the DATABASE_URL guard below

// ── Guards ──────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  console.error('[FATAL] seedLoadTestCohort.js is STAGING-ONLY. NODE_ENV=production refused.');
  process.exit(1);
}

// Print ONLY the hostname so the operator can eyeball the target DB (never credentials).
try {
  const dbUrl = new URL(process.env.DATABASE_URL || '');
  console.log(`[target] database host: ${dbUrl.hostname} — verify this is STAGING before proceeding.`);
} catch {
  console.error('[FATAL] DATABASE_URL is not set or not a valid URL. Aborting.');
  process.exit(1);
}

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { createToken } = require('../src/utils.js');
const config = require('../src/config/env.js');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ── Constants ───────────────────────────────────────────────────────────────
const argvCountIdx = process.argv.indexOf('--count');
const COUNT = Number(
  (argvCountIdx !== -1 && process.argv[argvCountIdx + 1]) || process.env.LT_COUNT || 10000
);
if (!Number.isSafeInteger(COUNT) || COUNT <= 0) {
  console.error('[FATAL] --count must be a positive integer.');
  process.exit(1);
}

const PASSWORD = 'LoadTest#2026';
const USER_EMAIL = (n) => `lt${String(n).padStart(5, '0')}@loadtest.local`;
const USER_SLUG = (n) => `ltu-${String(n).padStart(5, '0')}`;
const BROWSE_COURSE_SLUG = 'course-1';
// Slugs MUST match the app's SLUG_RE (^[a-z0-9]{12}$) — hyphenated fixtures
// 400 on every slug-validated route (caught by the L0 correctness stage).
const LT_COURSE_SLUG = 'loadtestquiz';
const LT_VIDEO_SLUG = 'loadtestvid1';

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

(async () => {
  // ── bcrypt: hash ONCE, reuse for all users ────────────────────────────────
  console.log(`[1/6] hashing password (bcrypt, saltRounds 10) for ${COUNT} users...`);
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  // ── Users: createMany in batches of 500, skipDuplicates (idempotent) ─────
  console.log(`[2/6] upserting ${COUNT} cohort users (batches of 500)...`);
  let createdUsers = 0;
  for (let n = 1; n <= COUNT; n += 500) {
    const batch = [];
    for (let u = n; u <= Math.min(n + 499, COUNT); u++) {
      const padded = String(u).padStart(5, '0');
      batch.push({
        email: USER_EMAIL(u),
        slug: USER_SLUG(u),
        name: `LoadTest ${padded}`,
        password: passwordHash,
        role: 'STUDENT',
        grade: 'FIRST_SECONDARY',
      });
    }
    const res = await prisma.user.createMany({ data: batch, skipDuplicates: true });
    createdUsers += res.count;
  }
  const skippedUsers = COUNT - createdUsers;
  console.log(`      users created=${createdUsers} skipped(existing)=${skippedUsers}`);

  // Refetch the WHOLE cohort (deterministic emails) — paginate at 2000.
  const cohort = [];
  for (let skip = 0; ; skip += 2000) {
    const page = await prisma.user.findMany({
      where: {
        email: { endsWith: '@loadtest.local', startsWith: 'lt' },
      },
      select: { id: true, email: true, slug: true },
      orderBy: { id: 'asc' },
      skip,
      take: 2000,
    });
    cohort.push(...page);
    if (page.length < 2000) break;
  }
  if (cohort.length !== COUNT) {
    throw new Error(`Cohort refetch got ${cohort.length} users, expected ${COUNT}.`);
  }
  console.log(`      refetched cohort: ${cohort.length} users`);

  // ── Browse fixture: course-1 (fallback: first course) + its first 2 videos ─
  console.log('[3/6] resolving browse fixture course + gate videos...');
  let browseCourse = await prisma.course.findUnique({ where: { slug: BROWSE_COURSE_SLUG } });
  if (!browseCourse) {
    browseCourse = await prisma.course.findFirst({ orderBy: { id: 'asc' } });
    if (!browseCourse) throw new Error('No course found in DB — cannot resolve browse fixture.');
    console.log(`      warning: no course '${BROWSE_COURSE_SLUG}', fell back to course id=${browseCourse.id} slug='${browseCourse.slug}'`);
  }
  const browseVideos = await prisma.bunnyVideo.findMany({
    where: { courseId: browseCourse.id },
    orderBy: { position: 'asc' },
    take: 2,
  });
  if (browseVideos.length === 0) {
    throw new Error(`Browse course id=${browseCourse.id} has no BunnyVideos — gate target unresolved.`);
  }
  const gateVideo = browseVideos[0]; // first video = always accessible gate target

  // ── Throwaway quiz course (quiz WRITES never touch real content) ──────────
  console.log('[4/6] upserting throwaway quiz course/video/quiz fixtures...');
  // Legacy fixture cleanup: the first seed used hyphenated slugs, which violate
  // SLUG_RE and 400 on every slug-validated route. Delete (cascades remove the
  // quiz, progress rows, and enrollments); the upserts below recreate cleanly.
  const legacyVideo = await prisma.bunnyVideo.findFirst({ where: { slug: 'loadtest-quiz-v1' } });
  if (legacyVideo) {
    await prisma.bunnyVideo.delete({ where: { id: legacyVideo.id } });
    console.log("      removed legacy video slug 'loadtest-quiz-v1' (quiz + progress cascaded)");
  }
  const legacyCourse = await prisma.course.findUnique({ where: { slug: 'loadtest-quiz' } });
  if (legacyCourse) {
    // FK order: Enrollment/Certificate/Payment have no ON DELETE CASCADE on
    // course (Payment.courseId is nullable without a rule → RESTRICT), so the
    // referencing rows must go first.
    await prisma.enrollment.deleteMany({ where: { courseId: legacyCourse.id } });
    await prisma.certificate.deleteMany({ where: { courseId: legacyCourse.id } });
    await prisma.payment.deleteMany({ where: { courseId: legacyCourse.id } });
    await prisma.course.delete({ where: { id: legacyCourse.id } });
    console.log("      removed legacy course slug 'loadtest-quiz' (enrollments + videos cascaded)");
  }
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { id: 'asc' } });
  if (!admin) throw new Error('No ADMIN user found — required as teacherId for the throwaway course.');
  const ltCourse = await prisma.course.upsert({
    where: { slug: LT_COURSE_SLUG },
    update: {},
    create: {
      title: 'LOADTEST Quiz Course',
      slug: LT_COURSE_SLUG,
      description: 'Synthetic course for load-test quiz writes',
      price: 0,
      thumbnail: '',
      grade: 'FIRST_SECONDARY',
      teacherId: admin.id,
    },
  });

  // Throwaway video (never uploaded to Bunny; playback is never called on it).
  let ltVideo = await prisma.bunnyVideo.findFirst({ where: { slug: LT_VIDEO_SLUG } });
  if (!ltVideo) {
    ltVideo = await prisma.bunnyVideo.create({
      data: {
        courseId: ltCourse.id,
        title: 'Load Test Video',
        slug: LT_VIDEO_SLUG,
        position: 1,
        bunnyVideoId: 'ltfakeguid000001',
        bunnyLibraryId: 'loadtest-library',
        duration: 60,
        status: 'READY',
      },
    });
  }

  // Quiz: upsert by bunnyVideoId (unique). maxAttempts huge → re-runs never exhaust.
  const ltQuiz = await prisma.quiz.upsert({
    where: { bunnyVideoId: ltVideo.id },
    update: {},
    create: {
      bunnyVideoId: ltVideo.id,
      title: 'Load Test Quiz',
      slug: 'loadtestqz01',
      passingScore: 50,
      maxAttempts: 1000000,
      timeLimitSec: 600,
      surveyJson: {
        elements: [
          {
            type: 'radiogroup',
            name: 'q1',
            title: '2+2=?',
            choices: [{ value: 'a', text: '3' }, { value: 'b', text: '4' }],
          },
          {
            type: 'radiogroup',
            name: 'q2',
            title: 'Capital of Egypt?',
            choices: [{ value: 'a', text: 'Alexandria' }, { value: 'b', text: 'Cairo' }],
          },
        ],
      },
      answerKey: {
        q1: { type: 'radiogroup', correctValue: 'b', points: 5 },
        q2: { type: 'radiogroup', correctValue: 'b', points: 5 },
      },
    },
  });

  // ── Enrollments: cohort → both courses (batches of 1000, skipDuplicates) ──
  console.log('[5/6] seeding enrollments (both courses) + completed progress on quiz video...');
  let enrollmentCount = 0;
  for (const batch of chunk(cohort, 1000)) {
    const rows = batch.flatMap((u) => [
      { userId: u.id, courseId: browseCourse.id, isPaid: true },
      { userId: u.id, courseId: ltCourse.id, isPaid: true },
    ]);
    const res = await prisma.enrollment.createMany({ data: rows, skipDuplicates: true });
    enrollmentCount += res.count;
  }

  // Progress: COMPLETED on the throwaway quiz video only — required because
  // POST /quizzes/videos/:slug/start 403s students without completed progress.
  // Do NOT seed progress on the browse course (first video is always accessible;
  // organic progress writes mutate state naturally during the test).
  let progressCount = 0;
  for (const batch of chunk(cohort, 1000)) {
    const rows = batch.map((u) => ({
      userId: u.id,
      bunnyVideoId: ltVideo.id,
      completed: true,
    }));
    const res = await prisma.bunnyVideoProgress.createMany({ data: rows, skipDuplicates: true });
    progressCount += res.count;
  }

  // ── JWTs: pre-generate 12h access tokens for k6 ───────────────────────────
  console.log('[6/6] generating 12h JWTs...');
  const tokens = cohort.map((u) => ({
    slug: u.slug,
    jwt: createToken(
      { id: u.id, email: u.email, name: u.email.replace(/@.*/, ''), role: 'STUDENT' },
      config.jwt.secret,
      '24h'
    ),
  }));

  // ── Write loadtest/.tokens.json ───────────────────────────────────────────
  const outDir = path.join(__dirname, '..', 'loadtest');
  fs.mkdirSync(outDir, { recursive: true });
  const tokensFile = path.join(outDir, '.tokens.json');
  fs.writeFileSync(
    tokensFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        password: PASSWORD,
        users: tokens,
        courses: {
          COURSE_SLUG: browseCourse.slug,
          GATE_VIDEO_SLUG: gateVideo.slug,
          QUIZ_VIDEO_SLUG: LT_VIDEO_SLUG,
          LT_COURSE_SLUG: LT_COURSE_SLUG,
          LT_VIDEO_SLUG: LT_VIDEO_SLUG,
        },
      },
      null,
      2
    )
  );

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n=== seedLoadTestCohort summary ===');
  console.log(`users: created=${createdUsers} skipped=${skippedUsers} (total ${cohort.length})`);
  console.log(`enrollments: ${enrollmentCount} new rows (2 per user: browse + LT course)`);
  console.log(`progress rows: ${progressCount} new (completed=true on quiz video only)`);
  console.log(`quiz: id=${ltQuiz.id} (maxAttempts=1000000, never exhausts)`);
  console.log('fixture map:');
  console.log(`  COURSE_SLUG      = ${browseCourse.slug}`);
  console.log(`  GATE_VIDEO_SLUG  = ${gateVideo.slug}`);
  console.log(`  QUIZ_VIDEO_SLUG  = ${LT_VIDEO_SLUG}`);
  console.log(`  LT_COURSE_SLUG   = ${LT_COURSE_SLUG}`);
  console.log(`  LT_VIDEO_SLUG    = ${LT_VIDEO_SLUG}`);
  console.log(`tokens written to: ${tokensFile}`);
  console.log('REMINDER: boot the server with LOAD_TEST=true.');

  await prisma.$disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error('SEED ERROR:', e);
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
