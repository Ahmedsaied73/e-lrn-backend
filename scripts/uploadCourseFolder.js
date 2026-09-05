'use strict';

/**
 * Bulk-upload all .mp4 files from a folder to Bunny Stream and register them
 * against a course in the local database.
 *
 * Uses the same service/client layer as the HTTP API but streams files directly
 * (no server proxy, no full-file buffering).
 *
 * Usage:
 *   node scripts/uploadCourseFolder.js [folderPath] [courseTitle]
 *
 * Examples:
 *   node scripts/uploadCourseFolder.js "I:\vids\TypeScript"
 *   node scripts/uploadCourseFolder.js "I:\vids\TypeScript" "Learn TypeScript in Arabic 2022"
 *
 * Options (env):
 *   UPLOAD_COURSE_ID  — attach to an existing course instead of creating one
 *   UPLOAD_DRY_RUN=1  — list files only, no uploads
 *   UPLOAD_START_AT=N — 1-based index to resume from (skips earlier files)
 *   UPLOAD_LIMIT=N    — stop after this lesson number (e.g. 10 = first 10 videos only)
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const prisma = require('../src/config/db');
const bunnyVideoService = require('../src/services/bunnyVideoService');
const bunnyClient = require('../src/integrations/bunny/bunnyStreamClient');

const FOLDER = process.argv[2] || 'I:\\vids\\TypeScript';
const COURSE_TITLE = process.argv[3] || 'Learn TypeScript in Arabic 2022';
const DRY_RUN = process.env.UPLOAD_DRY_RUN === '1';
const EXISTING_COURSE_ID = process.env.UPLOAD_COURSE_ID
  ? parseInt(process.env.UPLOAD_COURSE_ID, 10)
  : null;
const START_AT = Math.max(1, parseInt(process.env.UPLOAD_START_AT || '1', 10));
const UPLOAD_LIMIT = process.env.UPLOAD_LIMIT
  ? parseInt(process.env.UPLOAD_LIMIT, 10)
  : null;

const COURSE_DEFAULTS = {
  description:
    'دورة TypeScript بالعربي — من الأساسيات إلى Generics والـ OOP. فيديوهات مرفوعة على Bunny Stream.',
  price: 150,
  grade: 'THIRD_SECONDARY',
  thumbnail:
    'https://images.unsplash.com/photo-1516116216624-53e697fedbea?w=800',
  category: 'Programming',
};

function extractLessonNumber(filename) {
  const match = filename.match(/#\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function titleFromFilename(filename) {
  const base = path.basename(filename, path.extname(filename));
  const parts = base.split(' - ');
  if (parts.length >= 3) {
    return parts.slice(2).join(' - ').trim();
  }
  return base;
}

function listMp4Files(folder) {
  if (!fs.existsSync(folder)) {
    throw new Error(`Folder not found: ${folder}`);
  }

  return fs
    .readdirSync(folder)
    .filter((f) => f.toLowerCase().endsWith('.mp4'))
    .sort((a, b) => extractLessonNumber(a) - extractLessonNumber(b))
    .map((f) => path.join(folder, f));
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(2)} KB`;
}

async function getAdminUser() {
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (!admin) {
    throw new Error('No ADMIN user found. Start the server once to run setupDefaultAdmin.');
  }
  return admin;
}

async function getOrCreateCourse(adminId) {
  if (EXISTING_COURSE_ID) {
    const course = await prisma.course.findUnique({ where: { id: EXISTING_COURSE_ID } });
    if (!course) throw new Error(`Course not found: ${EXISTING_COURSE_ID}`);
    console.log(`Using existing course #${course.id}: "${course.title}"`);
    return course;
  }

  const existing = await prisma.course.findFirst({
    where: { title: COURSE_TITLE },
    select: { id: true, title: true },
  });

  if (existing) {
    console.log(`Course already exists #${existing.id}: "${existing.title}"`);
    return existing;
  }

  const course = await prisma.course.create({
    data: {
      ...COURSE_DEFAULTS,
      title: COURSE_TITLE,
      teacherId: adminId,
    },
  });

  console.log(`Created course #${course.id}: "${course.title}"`);
  return course;
}

async function ensureAdminEnrollment(adminId, courseId) {
  const existing = await prisma.enrollment.findFirst({
    where: { userId: adminId, courseId },
  });

  if (existing) return;

  await prisma.enrollment.create({
    data: {
      userId: adminId,
      courseId,
      isPaid: true,
      paymentDate: new Date(),
    },
  });

  console.log(`Enrolled admin in course #${courseId} for playback testing.`);
}

async function uploadOneFile({ courseId, adminId, filePath, index, total }) {
  const filename = path.basename(filePath);
  const title = titleFromFilename(filename);
  const size = fs.statSync(filePath).size;

  console.log(`\n[${index}/${total}] ${title}`);
  console.log(`  File: ${filename} (${formatBytes(size)})`);

  const video = await bunnyVideoService.createVideo({
    courseId,
    title,
    requestedByUserId: adminId,
  });

  console.log(`  Registered BunnyVideo #${video.id} (GUID: ${video.bunnyVideoId})`);

  await bunnyVideoService.transitionStatus(video.id, 'UPLOADING');

  const fileStream = fs.createReadStream(filePath);
  await bunnyClient.uploadVideoStream({
    bunnyVideoId: video.bunnyVideoId,
    fileStream,
  });

  await bunnyVideoService.transitionStatus(video.id, 'PROCESSING');

  console.log(`  Upload complete → PROCESSING (Bunny is encoding)`);

  return { id: video.id, title, bunnyVideoId: video.bunnyVideoId, status: 'PROCESSING' };
}

async function main() {
  console.log('=== Bunny Course Folder Upload ===');
  console.log(`Folder:  ${FOLDER}`);
  console.log(`Course:  ${COURSE_TITLE}`);
  console.log(`Start:   lesson #${START_AT}`);
  if (UPLOAD_LIMIT) console.log(`Limit:   first ${UPLOAD_LIMIT} lessons only`);
  if (DRY_RUN) console.log('Mode:    DRY RUN (no uploads)');

  const files = listMp4Files(FOLDER);
  if (files.length === 0) {
    throw new Error(`No .mp4 files found in ${FOLDER}`);
  }

  const totalBytes = files.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  console.log(`Found ${files.length} videos (${formatBytes(totalBytes)} total)`);

  if (DRY_RUN) {
    files.forEach((f, i) => {
      const n = i + 1;
      let tag = '';
      if (n < START_AT) tag = ' [SKIP]';
      else if (UPLOAD_LIMIT && n > UPLOAD_LIMIT) tag = ' [OVER LIMIT]';
      console.log(
        `${String(n).padStart(2, '0')}. ${titleFromFilename(path.basename(f))}${tag}`
      );
    });
    return;
  }

  const admin = await getAdminUser();
  const course = await getOrCreateCourse(admin.id);
  await ensureAdminEnrollment(admin.id, course.id);

  const results = [];
  const failures = [];

  const effectiveTotal = UPLOAD_LIMIT ? Math.min(UPLOAD_LIMIT, files.length) : files.length;

  for (let i = 0; i < files.length; i++) {
    const lessonNum = i + 1;
    if (lessonNum < START_AT) {
      console.log(`\n[${lessonNum}/${effectiveTotal}] Skipped (before UPLOAD_START_AT)`);
      continue;
    }
    if (UPLOAD_LIMIT && lessonNum > UPLOAD_LIMIT) {
      console.log(`\n[${lessonNum}/${effectiveTotal}] Skipped (over UPLOAD_LIMIT)`);
      continue;
    }

    try {
      const result = await uploadOneFile({
        courseId: course.id,
        adminId: admin.id,
        filePath: files[i],
        index: lessonNum,
        total: effectiveTotal,
      });
      results.push(result);
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      failures.push({ file: path.basename(files[i]), error: err.message });
    }
  }

  const summary = await bunnyVideoService.listCourseVideos(course.id, admin.id, 'ADMIN');

  console.log('\n========================================');
  console.log(' UPLOAD SUMMARY');
  console.log(` Course ID:     ${course.id}`);
  const planned = effectiveTotal - (START_AT - 1);
  console.log(` Uploaded:      ${results.length}/${planned}`);
  console.log(` Failed:        ${failures.length}`);
  console.log(` Bunny videos:  ${summary.length} total in DB`);
  console.log('========================================');
  console.log('\nFrontend endpoints:');
  console.log(`  GET /courses/${course.id}/bunny-videos`);
  console.log(`  GET /videos/:videoId/playback`);
  console.log('\nVideos will become READY after Bunny encoding (webhook or reconciliation job).');

  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f.file}: ${f.error}`));
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error('\nFatal error:', err.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
