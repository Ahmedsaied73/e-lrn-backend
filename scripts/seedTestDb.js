'use strict';

/**
 * Deterministic idempotent CI & local test database seed.
 * Creates baseline fixtures expected by the node:test suite on a fresh Postgres DB:
 *   - Admin (id 1): admin@elearning.com
 *   - SeqAccess student (id 2): seqaccess@localhost.test
 *   - GraderDemo student (id 3): grader-demo@localhost.test
 *   - Course #1 & Course #8 with READY BunnyVideos + MCQ/Essay quizzes
 */

const bcrypt = require('bcrypt');
const prisma = require('../src/config/db');
const { randomBase36Slug } = require('../src/utils/slugs');

async function ensureUser({ id, email, name, password, role, phoneNumber, grade = 'THIRD_SECONDARY' }) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  const hash = await bcrypt.hash(password, 10);
  return prisma.user.create({
    data: {
      id,
      slug: randomBase36Slug(),
      email,
      name,
      password: hash,
      role,
      phoneNumber,
      grade,
      essayPhotoEnabled: role === 'ADMIN',
    },
  });
}

async function main() {
  const admin = await ensureUser({
    id: 1,
    email: process.env.ADMIN_EMAIL || 'admin@elearning.com',
    name: 'Site Administrator',
    password: process.env.ADMIN_PASSWORD || 'TestAdminPassword#2026',
    role: 'ADMIN',
    phoneNumber: '01000000001',
  });

  const seqStudent = await ensureUser({
    id: 2,
    email: 'seqaccess@localhost.test',
    name: 'Seq Access Tester',
    password: 'SeqAccess#2026',
    role: 'STUDENT',
    phoneNumber: '01098765432',
  });

  const graderStudent = await ensureUser({
    id: 3,
    email: 'grader-demo@localhost.test',
    name: 'Grader Demo Student',
    password: 'GraderDemo#2026',
    role: 'STUDENT',
    phoneNumber: '01188800007',
  });

  // Ensure Course #1 (used by tests/quiz-lifecycle.test.js)
  let course1 = await prisma.course.findUnique({ where: { id: 1 } });
  if (!course1) {
    course1 = await prisma.course.create({
      data: {
        id: 1,
        slug: randomBase36Slug(),
        title: 'CI Baseline Course',
        description: 'Deterministic CI test course',
        grade: 'THIRD_SECONDARY',
        price: 0,
        thumbnail: 'https://via.placeholder.com/640x360',
        teacherId: admin.id,
      },
    });
  }

  for (const student of [seqStudent, graderStudent]) {
    await prisma.enrollment.upsert({
      where: { userId_courseId: { userId: student.id, courseId: course1.id } },
      update: { isPaid: true },
      create: { userId: student.id, courseId: course1.id, isPaid: true, paymentDate: new Date() },
    });
  }

  const v1 = await prisma.bunnyVideo.findUnique({ where: { id: 1 } }) ?? await prisma.bunnyVideo.create({
    data: {
      id: 1,
      slug: randomBase36Slug(),
      courseId: course1.id,
      title: 'CI Video 1',
      bunnyVideoId: 'ci-guid-1',
      bunnyLibraryId: '123456',
      status: 'READY',
      position: 1,
    },
  });

  const v2 = await prisma.bunnyVideo.findUnique({ where: { id: 2 } }) ?? await prisma.bunnyVideo.create({
    data: {
      id: 2,
      slug: randomBase36Slug(),
      courseId: course1.id,
      title: 'CI Video 2',
      bunnyVideoId: 'ci-guid-2',
      bunnyLibraryId: '123456',
      status: 'READY',
      position: 2,
    },
  });

  for (const vid of [v1, v2]) {
    const existingQuiz = await prisma.quiz.findUnique({ where: { bunnyVideoId: vid.id } });
    if (!existingQuiz) {
      await prisma.quiz.create({
        data: {
          slug: randomBase36Slug(),
          bunnyVideoId: vid.id,
          title: `CI Quiz ${vid.id}`,
          passingScore: 50,
          maxAttempts: 3,
          surveyJson: {
            pages: [{
              name: 'p1',
              elements: [
                {
                  type: 'radiogroup',
                  name: 'q1',
                  title: 'Question 1',
                  choices: [{ value: 'A', text: 'A' }, { value: 'B', text: 'B' }],
                },
              ],
            }],
          },
          answerKey: { q1: { type: 'radiogroup', points: 10, correctValue: 'A' } },
        },
      });
    }
  }

  // Advance sequences past explicit IDs so subsequent auto-increments never collide
  await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"User"', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM "User"), 10))`);
  await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"Course"', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM "Course"), 10))`);
  await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"BunnyVideo"', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM "BunnyVideo"), 10))`);

  console.log('[seedTestDb] CI fixtures ready.');
}

main()
  .catch((err) => {
    console.error('[seedTestDb] Failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
