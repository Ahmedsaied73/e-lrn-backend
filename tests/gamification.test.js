'use strict';

process.chdir(__dirname + '/..');
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app');
const prisma = require('../src/config/db');
const config = require('../src/config/env');
const { createToken } = require('../src/utils');
const { randomBase36Slug } = require('../src/utils/slugs');
const cache = require('../src/integrations/redis/cache');
const { isRedisEnabled, ensureConnected, disconnectRedis } = require('../src/integrations/redis/redisClient');
const gamificationService = require('../src/modules/gamification/gamification.service');
const gamifyCache = require('../src/modules/gamification/gamification.cache');
const {
  MAX_LEVEL,
  levelFloor,
  levelOf,
  levelName,
  progressOf,
  cairoDayKey,
  previousCairoDayKey,
} = require('../src/modules/gamification/gamification.constants');
const { upsertChallengeSchema } = require('../src/modules/gamification/gamification.validation');

// ── Unit Tests ────────────────────────────────────────────────────────────────

describe('Gamification constants & validation (unit)', () => {
  it('computes levelFloor, levelOf, progressOf, and levelName accurately including MAX_LEVEL cap', () => {
    assert.equal(levelFloor(1), 0);
    assert.equal(levelFloor(2), 100);
    assert.equal(levelFloor(3), 300);
    assert.equal(levelFloor(0), 0);

    assert.equal(levelOf(0), 1);
    assert.equal(levelOf(99), 1);
    assert.equal(levelOf(100), 2);
    assert.equal(levelOf(300), 3);
    assert.equal(levelOf(10_000_000), MAX_LEVEL);
    assert.equal(MAX_LEVEL, 30);

    assert.equal(levelName(1), 'مستكشف');
    assert.equal(levelName(5), 'نجم الفصل');
    assert.equal(levelName(6), 'أسطورة');
    assert.equal(levelName(30), 'أسطورة');

    const p0 = progressOf(0);
    assert.deepEqual(p0, { level: 1, levelName: 'مستكشف', pct: 0, left: 100 });

    const p50 = progressOf(50);
    assert.deepEqual(p50, { level: 1, levelName: 'مستكشف', pct: 50, left: 50 });

    const p100 = progressOf(100);
    assert.deepEqual(p100, { level: 2, levelName: 'متحمّس', pct: 0, left: 200 });

    const pMax = progressOf(levelFloor(MAX_LEVEL) + 5000);
    assert.deepEqual(pMax, { level: MAX_LEVEL, levelName: 'أسطورة', pct: 100, left: 0 });
  });

  it('computes cairoDayKey at UTC+2 boundary and previousCairoDayKey across month/year rollovers', () => {
    // January in Egypt is UTC+2 (no DST): 21:59:59Z is 23:59:59 Cairo; 22:00:00Z is 00:00:00 next day
    assert.equal(cairoDayKey(new Date('2026-01-15T21:59:59.000Z')), '2026-01-15');
    assert.equal(cairoDayKey(new Date('2026-01-15T22:00:00.000Z')), '2026-01-16');

    assert.equal(previousCairoDayKey('2026-03-01'), '2026-02-28');
    assert.equal(previousCairoDayKey('2024-03-01'), '2024-02-29'); // leap year
    assert.equal(previousCairoDayKey('2026-01-01'), '2025-12-31'); // year rollover
    assert.equal(previousCairoDayKey('bad-date'), null);
  });

  it('validates upsertChallengeSchema strictly with masteryPercent [50..100] and rewardXp [10..300]', () => {
    const valid = upsertChallengeSchema.safeParse({
      kind: 'MASTERY',
      quizSlug: null,
      title: 'تحدي الوحدة الأولى',
      rule: 'هات 80٪ على الأقل في الاختبار',
      masteryPercent: 80,
      rewardXp: 120,
      enabled: true,
    });
    assert.equal(valid.success, true);

    const unknownField = upsertChallengeSchema.safeParse({
      kind: 'MASTERY',
      title: 'تحدي',
      rule: 'شرط التحدي',
      masteryPercent: 80,
      rewardXp: 120,
      extra: 1,
    });
    assert.equal(unknownField.success, false);

    const lowMastery = upsertChallengeSchema.safeParse({
      kind: 'MASTERY',
      title: 'تحدي',
      rule: 'شرط التحدي',
      masteryPercent: 49,
      rewardXp: 120,
    });
    assert.equal(lowMastery.success, false);

    const highMastery = upsertChallengeSchema.safeParse({
      kind: 'MASTERY',
      title: 'تحدي',
      rule: 'شرط التحدي',
      masteryPercent: 101,
      rewardXp: 120,
    });
    assert.equal(highMastery.success, false);

    const lowXp = upsertChallengeSchema.safeParse({
      kind: 'MASTERY',
      title: 'تحدي',
      rule: 'شرط التحدي',
      masteryPercent: 80,
      rewardXp: 9,
    });
    assert.equal(lowXp.success, false);

    const highXp = upsertChallengeSchema.safeParse({
      kind: 'MASTERY',
      title: 'تحدي',
      rule: 'شرط التحدي',
      masteryPercent: 80,
      rewardXp: 301,
    });
    assert.equal(highXp.success, false);
  });
});

// ── Integration, Concurrency & Security Tests ─────────────────────────────────

describe('Gamification integration, concurrency & security', { concurrency: 1 }, () => {
  const tag = `gamify_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const testTenantId = `tenant_${tag}`;
  const origTenantId = config.gamification.tenantId;
  const origFeatureFlag = config.features.gamification;

  let server = null;
  let baseUrl = '';
  let adminUser = null;
  let adminCookie = '';
  let otherCourse = null;
  let otherVideo = null;
  let otherQuiz = null;

  const createdUserIds = [];
  const createdCourseIds = [];

  async function api(method, path, cookie, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      // non-JSON
    }
    return { status: res.status, json };
  }

  async function makeStudent(suffix) {
    const email = `${tag}_${suffix}@localhost.test`;
    const user = await prisma.user.create({
      data: {
        slug: randomBase36Slug(),
        name: `Student ${suffix}`,
        email,
        password: 'TestPassword123!',
        role: 'STUDENT',
        grade: 'FIRST_SECONDARY',
      },
    });
    createdUserIds.push(user.id);
    const token = createToken(
      { id: user.id, email: user.email, name: user.name, role: 'STUDENT' },
      config.jwt.secret
    );
    return { user, cookie: `accessToken=${token}` };
  }

  async function setTenantGamification(enabled) {
    await prisma.teacherSettings.upsert({
      where: { tenantId: testTenantId },
      create: { tenantId: testTenantId, gamificationEnabled: enabled },
      update: { gamificationEnabled: enabled },
    });
    await gamifyCache.invalidateFlagCache(testTenantId);
  }

  function make5QuestionQuizPayloads() {
    const elements = [];
    const answerKey = {};
    for (let i = 1; i <= 5; i += 1) {
      const qName = `q${i}`;
      elements.push({
        type: 'radiogroup',
        name: qName,
        title: `سؤال ${i}`,
        choices: ['a', 'b'],
      });
      answerKey[qName] = { type: 'radiogroup', correctValue: 'a', points: 1 };
    }
    return {
      surveyJson: { pages: [{ name: 'p1', elements }] },
      answerKey,
    };
  }

  before(async () => {
    config.gamification.tenantId = testTenantId;
    config.features.gamification = false;

    if (isRedisEnabled()) {
      await ensureConnected().catch(() => null);
    }

    adminUser = await prisma.user.create({
      data: {
        slug: randomBase36Slug(),
        name: `Admin ${tag}`,
        email: `${tag}_admin@localhost.test`,
        password: 'TestPassword123!',
        role: 'ADMIN',
        grade: 'FIRST_SECONDARY',
      },
    });
    createdUserIds.push(adminUser.id);
    adminCookie = `accessToken=${createToken(
      { id: adminUser.id, email: adminUser.email, name: adminUser.name, role: 'ADMIN' },
      config.jwt.secret
    )}`;

    // Secondary course + quiz used for IDOR test
    otherCourse = await prisma.course.create({
      data: {
        title: `Other Course ${tag}`,
        slug: randomBase36Slug(),
        description: 'Other course for IDOR tests',
        price: 100,
        thumbnail: 'https://example.com/thumb.jpg',
        grade: 'FIRST_SECONDARY',
        teacherId: adminUser.id,
      },
    });
    createdCourseIds.push(otherCourse.id);

    otherVideo = await prisma.bunnyVideo.create({
      data: {
        courseId: otherCourse.id,
        title: `Other Video ${tag}`,
        slug: randomBase36Slug(),
        position: 1,
        bunnyVideoId: `bunny_${tag}_other`,
        bunnyLibraryId: 'lib_test',
        status: 'READY',
      },
    });

    const { surveyJson, answerKey } = make5QuestionQuizPayloads();
    otherQuiz = await prisma.quiz.create({
      data: {
        bunnyVideoId: otherVideo.id,
        title: `Other Quiz ${tag}`,
        slug: randomBase36Slug(),
        passingScore: 50,
        maxAttempts: 3,
        surveyJson,
        answerKey,
      },
    });

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    config.gamification.tenantId = origTenantId;
    config.features.gamification = origFeatureFlag;

    await gamifyCache.invalidateFlagCache(testTenantId);
    for (const uid of createdUserIds) {
      await gamifyCache.invalidateStudentCaches(testTenantId, uid);
    }

    if (createdUserIds.length > 0) {
      await prisma.xpEvent.deleteMany({ where: { studentId: { in: createdUserIds } } });
      await prisma.studentBadge.deleteMany({ where: { studentId: { in: createdUserIds } } });
      await prisma.studentGamification.deleteMany({ where: { studentId: { in: createdUserIds } } });
      await prisma.quizAttempt.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.bunnyVideoProgress.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.enrollment.deleteMany({ where: { userId: { in: createdUserIds } } });
    }

    if (createdCourseIds.length > 0) {
      await prisma.courseChallenge.deleteMany({ where: { courseId: { in: createdCourseIds } } });
      await prisma.enrollment.deleteMany({ where: { courseId: { in: createdCourseIds } } });
      await prisma.course.deleteMany({ where: { id: { in: createdCourseIds } } });
    }

    await prisma.teacherSettings.deleteMany({ where: { tenantId: testTenantId } });

    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    await disconnectRedis().catch(() => {});
    await prisma.$disconnect();
  });

  it('1. Feature flag disabled: mints zero rows, returns null award, and HUD returns { enabled: false }', async () => {
    await setTenantGamification(false);
    const { user, cookie } = await makeStudent('disabled');

    const course = await prisma.course.create({
      data: {
        title: `Disabled Course ${tag}`,
        slug: randomBase36Slug(),
        description: 'desc',
        price: 100,
        thumbnail: 'https://example.com/t.jpg',
        grade: 'FIRST_SECONDARY',
        teacherId: adminUser.id,
      },
    });
    createdCourseIds.push(course.id);

    const video = await prisma.bunnyVideo.create({
      data: {
        courseId: course.id,
        title: 'Lesson 1',
        slug: randomBase36Slug(),
        position: 1,
        bunnyVideoId: `bunny_${tag}_dis_1`,
        bunnyLibraryId: 'lib_test',
        status: 'READY',
      },
    });

    const { surveyJson, answerKey } = make5QuestionQuizPayloads();
    const quiz = await prisma.quiz.create({
      data: {
        bunnyVideoId: video.id,
        title: 'Disabled Quiz',
        slug: randomBase36Slug(),
        passingScore: 50,
        maxAttempts: 3,
        surveyJson,
        answerKey,
      },
    });

    await prisma.enrollment.create({
      data: { userId: user.id, courseId: course.id, isPaid: true },
    });

    const attempt = await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId: user.id,
        attemptNumber: 1,
        status: 'GRADED',
        submittedAt: new Date(),
        responses: { q1: 'a', q2: 'a', q3: 'a', q4: 'a', q5: 'a' },
        mcqEarned: 5,
        totalPoints: 5,
        earnedPoints: 5,
        scorePercent: 100,
      },
    });

    const lessonAward = await gamificationService.awardForLessonComplete({
      tenantId: testTenantId,
      studentId: user.id,
      lessonId: video.id,
      courseId: course.id,
    });
    assert.equal(lessonAward, null);

    const quizAward = await gamificationService.awardForQuizSubmit({
      tenantId: testTenantId,
      studentId: user.id,
      attemptId: attempt.id,
    });
    assert.equal(quizAward, null);

    const hudRes = await api('GET', '/api/gamification/hud', cookie);
    assert.equal(hudRes.status, 200);
    assert.equal(hudRes.json.success, true);
    assert.equal(hudRes.json.data.enabled, false);

    const [evCount, profileCount] = await Promise.all([
      prisma.xpEvent.count({ where: { tenantId: testTenantId, studentId: user.id } }),
      prisma.studentGamification.count({ where: { tenantId: testTenantId, studentId: user.id } }),
    ]);
    assert.equal(evCount, 0);
    assert.equal(profileCount, 0);
  });

  it('2. Concurrency & Idempotency: 10 concurrent awardForLessonComplete calls mint XP exactly once (30 XP)', async () => {
    await setTenantGamification(true);
    const { user } = await makeStudent('conc');

    const course = await prisma.course.create({
      data: {
        title: `Conc Course ${tag}`,
        slug: randomBase36Slug(),
        description: 'desc',
        price: 100,
        thumbnail: 'https://example.com/t.jpg',
        grade: 'FIRST_SECONDARY',
        teacherId: adminUser.id,
      },
    });
    createdCourseIds.push(course.id);

    const v1 = await prisma.bunnyVideo.create({
      data: {
        courseId: course.id,
        title: 'Lesson 1',
        slug: randomBase36Slug(),
        position: 1,
        bunnyVideoId: `bunny_${tag}_conc_1`,
        bunnyLibraryId: 'lib_test',
        status: 'READY',
      },
    });
    await prisma.bunnyVideo.create({
      data: {
        courseId: course.id,
        title: 'Lesson 2',
        slug: randomBase36Slug(),
        position: 2,
        bunnyVideoId: `bunny_${tag}_conc_2`,
        bunnyLibraryId: 'lib_test',
        status: 'READY',
      },
    });

    await prisma.enrollment.create({
      data: { userId: user.id, courseId: course.id, isPaid: true },
    });
    await prisma.bunnyVideoProgress.create({
      data: { userId: user.id, bunnyVideoId: v1.id, completed: true },
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        gamificationService.awardForLessonComplete({
          tenantId: testTenantId,
          studentId: user.id,
          lessonId: v1.id,
          courseId: course.id,
        })
      )
    );

    const nonNull = results.filter(Boolean);
    assert.equal(nonNull.length, 1, 'exactly one concurrent caller should win the mint');
    assert.equal(nonNull[0].totalGain, 30);
    assert.equal(nonNull[0].newTotalXp, 30);
    assert.equal(nonNull[0].completedLessonsCount, 1);
    assert.equal(nonNull[0].totalLessonsCount, 2);

    const lessonEvents = await prisma.xpEvent.count({
      where: { tenantId: testTenantId, studentId: user.id, type: 'LESSON_COMPLETE' },
    });
    assert.equal(lessonEvents, 1);

    const profile = await prisma.studentGamification.findUnique({
      where: { tenantId_studentId: { tenantId: testTenantId, studentId: user.id } },
    });
    assert.equal(profile.totalXp, 30);
    assert.equal(profile.currentStreak, 1);
    assert.equal(profile.completedLessonsCnt, 1);
  });

  it('3. Cairo streak rollover: same day no second +10 XP; yesterday increments streak; 2-day gap resets to 1', async () => {
    await setTenantGamification(true);
    const todayKey = cairoDayKey();
    const yesterdayKey = previousCairoDayKey(todayKey);
    const twoDaysAgoKey = previousCairoDayKey(yesterdayKey);

    const course = await prisma.course.create({
      data: {
        title: `Streak Course ${tag}`,
        slug: randomBase36Slug(),
        description: 'desc',
        price: 100,
        thumbnail: 'https://example.com/t.jpg',
        grade: 'FIRST_SECONDARY',
        teacherId: adminUser.id,
      },
    });
    createdCourseIds.push(course.id);

    const v1 = await prisma.bunnyVideo.create({
      data: {
        courseId: course.id,
        title: 'S1',
        slug: randomBase36Slug(),
        position: 1,
        bunnyVideoId: `bunny_${tag}_st_1`,
        bunnyLibraryId: 'lib_test',
        status: 'READY',
      },
    });
    const v2 = await prisma.bunnyVideo.create({
      data: {
        courseId: course.id,
        title: 'S2',
        slug: randomBase36Slug(),
        position: 2,
        bunnyVideoId: `bunny_${tag}_st_2`,
        bunnyLibraryId: 'lib_test',
        status: 'READY',
      },
    });

    // Same day: second lesson does NOT grant another +10 streak XP
    const { user: stuSame } = await makeStudent('streak_same');
    await prisma.enrollment.create({ data: { userId: stuSame.id, courseId: course.id, isPaid: true } });
    const first = await gamificationService.awardForLessonComplete({
      tenantId: testTenantId,
      studentId: stuSame.id,
      lessonId: v1.id,
      courseId: course.id,
    });
    assert.equal(first.totalGain, 30);
    assert.equal(first.newStreak, 1);

    const second = await gamificationService.awardForLessonComplete({
      tenantId: testTenantId,
      studentId: stuSame.id,
      lessonId: v2.id,
      courseId: course.id,
    });
    assert.equal(second.totalGain, 20);
    assert.equal(second.newStreak, 1);
    const streakEventsSame = await prisma.xpEvent.count({
      where: { tenantId: testTenantId, studentId: stuSame.id, type: 'STREAK_DAILY' },
    });
    assert.equal(streakEventsSame, 1);

    // Yesterday -> streak + 1
    const { user: stuYesterday } = await makeStudent('streak_yest');
    await prisma.enrollment.create({ data: { userId: stuYesterday.id, courseId: course.id, isPaid: true } });
    await prisma.studentGamification.create({
      data: {
        tenantId: testTenantId,
        studentId: stuYesterday.id,
        totalXp: 50,
        currentStreak: 3,
        longestStreak: 3,
        lastActiveDayKey: yesterdayKey,
      },
    });
    const yestAward = await gamificationService.awardForLessonComplete({
      tenantId: testTenantId,
      studentId: stuYesterday.id,
      lessonId: v1.id,
      courseId: course.id,
    });
    assert.equal(yestAward.newStreak, 4);
    assert.equal(yestAward.totalGain, 30);
    assert.equal(yestAward.newTotalXp, 80);

    // 2-day gap -> streak resets to 1
    const { user: stuGap } = await makeStudent('streak_gap');
    await prisma.enrollment.create({ data: { userId: stuGap.id, courseId: course.id, isPaid: true } });
    await prisma.studentGamification.create({
      data: {
        tenantId: testTenantId,
        studentId: stuGap.id,
        totalXp: 50,
        currentStreak: 5,
        longestStreak: 5,
        lastActiveDayKey: twoDaysAgoKey,
      },
    });
    const gapAward = await gamificationService.awardForLessonComplete({
      tenantId: testTenantId,
      studentId: stuGap.id,
      lessonId: v1.id,
      courseId: course.id,
    });
    assert.equal(gapAward.newStreak, 1);
    assert.equal(gapAward.totalGain, 30);
  });

  it('4. Quiz delta-only & improvement bonus + getQuizResult includes quizSlug', async () => {
    await setTenantGamification(true);
    const { user, cookie } = await makeStudent('quiz_delta');

    const course = await prisma.course.create({
      data: {
        title: `Quiz Course ${tag}`,
        slug: randomBase36Slug(),
        description: 'desc',
        price: 100,
        thumbnail: 'https://example.com/t.jpg',
        grade: 'SECOND_SECONDARY',
        teacherId: adminUser.id,
      },
    });
    createdCourseIds.push(course.id);

    const video = await prisma.bunnyVideo.create({
      data: {
        courseId: course.id,
        title: 'Lesson Q',
        slug: randomBase36Slug(),
        position: 1,
        bunnyVideoId: `bunny_${tag}_qd_1`,
        bunnyLibraryId: 'lib_test',
        status: 'READY',
      },
    });

    const { surveyJson, answerKey } = make5QuestionQuizPayloads();
    const quiz = await prisma.quiz.create({
      data: {
        bunnyVideoId: video.id,
        title: 'Delta Quiz',
        slug: randomBase36Slug(),
        passingScore: 50,
        maxAttempts: 5,
        surveyJson,
        answerKey,
      },
    });

    // Seed today's streak so quiz XP assertions isolate pure quiz weights
    await prisma.studentGamification.create({
      data: {
        tenantId: testTenantId,
        studentId: user.id,
        totalXp: 10,
        currentStreak: 1,
        longestStreak: 1,
        lastActiveDayKey: cairoDayKey(),
      },
    });

    // Attempt 1: 3/5 = 60% -> 30 XP (3 * 10)
    const a1 = await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId: user.id,
        attemptNumber: 1,
        status: 'GRADED',
        submittedAt: new Date(),
        responses: { q1: 'a', q2: 'a', q3: 'a', q4: 'b', q5: 'b' },
        mcqEarned: 3,
        totalPoints: 5,
        earnedPoints: 3,
        scorePercent: 60,
      },
    });
    const aw1 = await gamificationService.awardForQuizSubmit({
      tenantId: testTenantId,
      studentId: user.id,
      attemptId: a1.id,
    });
    assert.equal(aw1.totalGain, 30);
    assert.equal(aw1.correct, 3);
    assert.equal(aw1.count, 5);
    assert.equal(aw1.pct, 60);

    // Attempt 2: lower score 2/5 = 40% -> 0 XP
    const a2 = await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId: user.id,
        attemptNumber: 2,
        status: 'GRADED',
        submittedAt: new Date(),
        responses: { q1: 'a', q2: 'a', q3: 'b', q4: 'b', q5: 'b' },
        mcqEarned: 2,
        totalPoints: 5,
        earnedPoints: 2,
        scorePercent: 40,
      },
    });
    const aw2 = await gamificationService.awardForQuizSubmit({
      tenantId: testTenantId,
      studentId: user.id,
      attemptId: a2.id,
    });
    assert.equal(aw2.totalGain, 0);
    assert.equal(aw2.lines.length, 0);

    // Attempt 3: equal score 3/5 = 60% -> 0 XP
    const a3 = await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId: user.id,
        attemptNumber: 3,
        status: 'GRADED',
        submittedAt: new Date(),
        responses: { q1: 'a', q2: 'a', q3: 'a', q4: 'b', q5: 'b' },
        mcqEarned: 3,
        totalPoints: 5,
        earnedPoints: 3,
        scorePercent: 60,
      },
    });
    const aw3 = await gamificationService.awardForQuizSubmit({
      tenantId: testTenantId,
      studentId: user.id,
      attemptId: a3.id,
    });
    assert.equal(aw3.totalGain, 0);

    // Attempt 4: higher score 5/5 = 100% -> delta 20 XP + improvement 20 XP + perfect 30 XP = 70 XP
    const a4 = await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId: user.id,
        attemptNumber: 4,
        status: 'GRADED',
        submittedAt: new Date(),
        responses: { q1: 'a', q2: 'a', q3: 'a', q4: 'a', q5: 'a' },
        mcqEarned: 5,
        totalPoints: 5,
        earnedPoints: 5,
        scorePercent: 100,
      },
    });
    const aw4 = await gamificationService.awardForQuizSubmit({
      tenantId: testTenantId,
      studentId: user.id,
      attemptId: a4.id,
    });
    assert.equal(aw4.totalGain, 70);
    assert.equal(aw4.newTotalXp, 110);
    assert.ok(aw4.unlockedBadges.includes('perfect'));
    assert.ok(aw4.unlockedBadges.includes('learner'));

    // Verify GET /quizzes/attempts/:id/result includes quizSlug & gamificationAward
    const res = await api('GET', `/quizzes/attempts/${a4.id}/result`, cookie);
    assert.equal(res.status, 200);
    assert.equal(res.json.data.quizSlug, quiz.slug);
    assert.ok(res.json.data.gamificationAward);
    assert.equal(res.json.data.gamificationAward.totalGain, 70);
  });

  it('5. Teacher Challenge lifecycle + Summary & Challenge contract alignment', async () => {
    await setTenantGamification(true);
    const { user, cookie } = await makeStudent('challenge');

    const course = await prisma.course.create({
      data: {
        title: `Challenge Course ${tag}`,
        slug: randomBase36Slug(),
        description: 'desc',
        price: 100,
        thumbnail: 'https://example.com/t.jpg',
        grade: 'THIRD_SECONDARY',
        teacherId: adminUser.id,
      },
    });
    createdCourseIds.push(course.id);

    const v1 = await prisma.bunnyVideo.create({
      data: {
        courseId: course.id,
        title: 'Lesson 1',
        slug: randomBase36Slug(),
        position: 1,
        bunnyVideoId: `bunny_${tag}_ch_1`,
        bunnyLibraryId: 'lib_test',
        status: 'READY',
      },
    });
    const v2 = await prisma.bunnyVideo.create({
      data: {
        courseId: course.id,
        title: 'Lesson 2',
        slug: randomBase36Slug(),
        position: 2,
        bunnyVideoId: `bunny_${tag}_ch_2`,
        bunnyLibraryId: 'lib_test',
        status: 'READY',
      },
    });

    const { surveyJson, answerKey } = make5QuestionQuizPayloads();
    const quiz = await prisma.quiz.create({
      data: {
        bunnyVideoId: v2.id,
        title: 'Final Challenge Quiz',
        slug: randomBase36Slug(),
        passingScore: 50,
        maxAttempts: 5,
        surveyJson,
        answerKey,
      },
    });

    await prisma.enrollment.create({ data: { userId: user.id, courseId: course.id, isPaid: true } });

    await gamificationService.upsertCourseChallenge(testTenantId, course.slug, {
      kind: 'MASTERY',
      quizSlug: quiz.slug,
      title: 'تحدي إتقان الوحدة',
      rule: 'هات 80٪ أو أكتر في الاختبار النهائي',
      masteryPercent: 80,
      rewardXp: 120,
      enabled: true,
    });

    // While lessons are incomplete, challenge is locked and NOT awarded
    const chLocked = await gamificationService.getCourseChallenge(testTenantId, user.id, course.slug, false);
    assert.equal(chLocked.enabled, true);
    assert.equal(chLocked.configured, true);
    assert.equal(chLocked.status, 'locked');
    assert.equal(chLocked.remainingLessons, 2);
    assert.equal(chLocked.videoSlug, v2.slug);

    const aLocked = await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId: user.id,
        attemptNumber: 1,
        status: 'GRADED',
        submittedAt: new Date(),
        responses: { q1: 'a', q2: 'a', q3: 'a', q4: 'a', q5: 'a' },
        mcqEarned: 5,
        totalPoints: 5,
        earnedPoints: 5,
        scorePercent: 100,
      },
    });
    const awLocked = await gamificationService.awardForQuizSubmit({
      tenantId: testTenantId,
      studentId: user.id,
      attemptId: aLocked.id,
    });
    assert.equal(awLocked.challengeResult, 'none');
    assert.equal(awLocked.challengeMasteryPercent, 80);

    // Complete all lessons -> challenge opens & summary nextAction includes videoSlug
    await prisma.bunnyVideoProgress.createMany({
      data: [
        { userId: user.id, bunnyVideoId: v1.id, completed: true },
        { userId: user.id, bunnyVideoId: v2.id, completed: true },
      ],
    });
    await gamifyCache.invalidateStudentCaches(testTenantId, user.id);

    const chOpen = await gamificationService.getCourseChallenge(testTenantId, user.id, course.slug, false);
    assert.equal(chOpen.status, 'open');
    assert.equal(chOpen.remainingLessons, 0);

    const sumOpenRes = await api('GET', '/api/gamification/summary', cookie);
    assert.equal(sumOpenRes.status, 200);
    const sumOpen = sumOpenRes.json.data;
    assert.equal(sumOpen.enabled, true);
    assert.equal(sumOpen.nextAction.type, 'challenge');
    assert.equal(sumOpen.nextAction.videoSlug, v2.slug);
    assert.equal(sumOpen.nextAction.quizSlug, quiz.slug);
    assert.equal(sumOpen.courses[0].grade, 'الصف الثالث الثانوي');
    assert.equal(sumOpen.exams[0].courseSlug, course.slug);
    assert.equal(sumOpen.exams[0].isChallenge, true);
    assert.equal(typeof sumOpen.exams[0].date, 'string');
    assert.equal(typeof sumOpen.averageExamPct, 'number');
    assert.ok(Array.isArray(sumOpen.log));

    // Attempt with pct < masteryPercent (60 < 80) -> challengeResult = 'failed'
    const aFail = await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId: user.id,
        attemptNumber: 2,
        status: 'GRADED',
        submittedAt: new Date(),
        responses: { q1: 'a', q2: 'a', q3: 'a', q4: 'b', q5: 'b' },
        mcqEarned: 3,
        totalPoints: 5,
        earnedPoints: 3,
        scorePercent: 60,
      },
    });
    const awFail = await gamificationService.awardForQuizSubmit({
      tenantId: testTenantId,
      studentId: user.id,
      attemptId: aFail.id,
    });
    assert.equal(awFail.challengeResult, 'failed');
    assert.equal(awFail.challengeMasteryPercent, 80);

    // Attempt with pct >= masteryPercent (80 >= 80) -> challengeResult = 'passed', +120 XP
    const aPass = await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId: user.id,
        attemptNumber: 3,
        status: 'GRADED',
        submittedAt: new Date(),
        responses: { q1: 'a', q2: 'a', q3: 'a', q4: 'a', q5: 'b' },
        mcqEarned: 4,
        totalPoints: 5,
        earnedPoints: 4,
        scorePercent: 80,
      },
    });
    const awPass = await gamificationService.awardForQuizSubmit({
      tenantId: testTenantId,
      studentId: user.id,
      attemptId: aPass.id,
    });
    assert.equal(awPass.challengeResult, 'passed');
    assert.equal(awPass.challengeMasteryPercent, 80);
    assert.ok(awPass.lines.some((l) => l.value === 120));
    assert.ok(awPass.unlockedBadges.includes('master'));

    // Second attempt after passing -> challengeResult = 'already' with 0 duplicate challenge XP
    const aSecond = await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId: user.id,
        attemptNumber: 4,
        status: 'GRADED',
        submittedAt: new Date(),
        responses: { q1: 'a', q2: 'a', q3: 'a', q4: 'a', q5: 'a' },
        mcqEarned: 5,
        totalPoints: 5,
        earnedPoints: 5,
        scorePercent: 100,
      },
    });
    const awSecond = await gamificationService.awardForQuizSubmit({
      tenantId: testTenantId,
      studentId: user.id,
      attemptId: aSecond.id,
    });
    assert.equal(awSecond.challengeResult, 'already');

    const chEvents = await prisma.xpEvent.count({
      where: { tenantId: testTenantId, studentId: user.id, type: 'TEACHER_CHALLENGE' },
    });
    assert.equal(chEvents, 1);

    const chDone = await gamificationService.getCourseChallenge(testTenantId, user.id, course.slug, false);
    assert.equal(chDone.status, 'done');
  });

  it('6. Security (RBAC, IDOR, strict validation, no public XP minting endpoint)', async () => {
    await setTenantGamification(true);
    const { cookie: studentCookie } = await makeStudent('sec');

    const course = await prisma.course.create({
      data: {
        title: `Sec Course ${tag}`,
        slug: randomBase36Slug(),
        description: 'desc',
        price: 100,
        thumbnail: 'https://example.com/t.jpg',
        grade: 'FIRST_SECONDARY',
        teacherId: adminUser.id,
      },
    });
    createdCourseIds.push(course.id);

    const video = await prisma.bunnyVideo.create({
      data: {
        courseId: course.id,
        title: 'Sec Video',
        slug: randomBase36Slug(),
        position: 1,
        bunnyVideoId: `bunny_${tag}_sec_1`,
        bunnyLibraryId: 'lib_test',
        status: 'READY',
      },
    });
    const { surveyJson, answerKey } = make5QuestionQuizPayloads();
    const quiz = await prisma.quiz.create({
      data: {
        bunnyVideoId: video.id,
        title: 'Sec Quiz',
        slug: randomBase36Slug(),
        passingScore: 50,
        maxAttempts: 3,
        surveyJson,
        answerKey,
      },
    });

    // No public XP minting endpoint
    const mintRes = await api('POST', '/api/gamification/award', studentCookie, { amount: 9999 });
    assert.equal(mintRes.status, 404);

    // Student calling admin challenge endpoint -> 403
    const studentPut = await api('PUT', `/api/admin/courses/${course.slug}/challenge`, studentCookie, {
      kind: 'MASTERY',
      quizSlug: quiz.slug,
      title: 'تحدي',
      rule: 'شرط',
      masteryPercent: 80,
      rewardXp: 100,
    });
    assert.equal(studentPut.status, 403);

    // Admin passing quizSlug from a DIFFERENT course -> 403 (IDOR blocked)
    const idorPut = await api('PUT', `/api/admin/courses/${course.slug}/challenge`, adminCookie, {
      kind: 'MASTERY',
      quizSlug: otherQuiz.slug,
      title: 'تحدي',
      rule: 'شرط',
      masteryPercent: 80,
      rewardXp: 100,
    });
    assert.equal(idorPut.status, 403);

    // Admin passing extra fields -> 400 (.strict())
    const extraPut = await api('PUT', `/api/admin/courses/${course.slug}/challenge`, adminCookie, {
      kind: 'MASTERY',
      quizSlug: quiz.slug,
      title: 'تحدي',
      rule: 'شرط',
      masteryPercent: 80,
      rewardXp: 100,
      extra: 1,
    });
    assert.equal(extraPut.status, 400);

    // Admin valid PUT -> 200 flat CourseChallengeData including videoSlug
    const okPut = await api('PUT', `/api/admin/courses/${course.slug}/challenge`, adminCookie, {
      kind: 'MASTERY',
      quizSlug: quiz.slug,
      title: 'تحدي الأمان',
      rule: 'هات 80٪',
      masteryPercent: 80,
      rewardXp: 100,
      enabled: true,
    });
    assert.equal(okPut.status, 200);
    assert.equal(okPut.json.data.courseSlug, course.slug);
    assert.equal(okPut.json.data.quizSlug, quiz.slug);
    assert.equal(okPut.json.data.videoSlug, video.slug);
    assert.equal(okPut.json.data.configured, true);
  });

  it('7. Fail-safe isolation: throwing inside awardForLessonComplete does not break POST /progress/complete', async () => {
    await setTenantGamification(true);
    const { user, cookie } = await makeStudent('failsafe');

    const course = await prisma.course.create({
      data: {
        title: `FailSafe Course ${tag}`,
        slug: randomBase36Slug(),
        description: 'desc',
        price: 100,
        thumbnail: 'https://example.com/t.jpg',
        grade: 'FIRST_SECONDARY',
        teacherId: adminUser.id,
      },
    });
    createdCourseIds.push(course.id);

    const video = await prisma.bunnyVideo.create({
      data: {
        courseId: course.id,
        title: 'FS Video',
        slug: randomBase36Slug(),
        position: 1,
        bunnyVideoId: `bunny_${tag}_fs_1`,
        bunnyLibraryId: 'lib_test',
        status: 'READY',
      },
    });

    await prisma.enrollment.create({ data: { userId: user.id, courseId: course.id, isPaid: true } });

    const origAward = gamificationService.awardForLessonComplete;
    gamificationService.awardForLessonComplete = async () => {
      throw new Error('simulated gamification failure');
    };

    try {
      const res = await api('POST', '/progress/complete', cookie, { videoSlug: video.slug });
      assert.equal(res.status, 200);
      assert.equal(res.json.videoSlug, video.slug);
      assert.equal(res.json.videoProgress.completed, true);
      assert.equal(res.json.gamificationAward, undefined);
    } finally {
      gamificationService.awardForLessonComplete = origAward;
    }
  });

  it('8. Redis cache invalidation: getHud caches and awardForLessonComplete invalidates gamify:hud after commit', async () => {
    await setTenantGamification(true);
    const { user } = await makeStudent('cache');

    const course = await prisma.course.create({
      data: {
        title: `Cache Course ${tag}`,
        slug: randomBase36Slug(),
        description: 'desc',
        price: 100,
        thumbnail: 'https://example.com/t.jpg',
        grade: 'FIRST_SECONDARY',
        teacherId: adminUser.id,
      },
    });
    createdCourseIds.push(course.id);

    const video = await prisma.bunnyVideo.create({
      data: {
        courseId: course.id,
        title: 'Cache Video',
        slug: randomBase36Slug(),
        position: 1,
        bunnyVideoId: `bunny_${tag}_cache_1`,
        bunnyLibraryId: 'lib_test',
        status: 'READY',
      },
    });

    await prisma.enrollment.create({ data: { userId: user.id, courseId: course.id, isPaid: true } });

    const hudKey = gamifyCache.hudKey(testTenantId, user.id);
    const hudBefore = await gamificationService.getHud(testTenantId, user.id);
    assert.equal(hudBefore.xp, 0);

    // Track cache.del calls so the assertion holds whether Redis is live or disabled in CI
    const delCalls = [];
    const origDel = cache.del;
    cache.del = async (...keys) => {
      delCalls.push(...keys.flat());
      return origDel.apply(cache, keys);
    };

    try {
      const cachedBefore = await cache.get(hudKey);
      if (isRedisEnabled() && cachedBefore !== null) {
        assert.equal(cachedBefore.xp, 0);
      }

      await gamificationService.awardForLessonComplete({
        tenantId: testTenantId,
        studentId: user.id,
        lessonId: video.id,
        courseId: course.id,
      });

      assert.ok(delCalls.includes(hudKey), 'awardForLessonComplete must invalidate gamify:hud cache key');
      const cachedAfter = await cache.get(hudKey);
      assert.equal(cachedAfter, null, 'gamify:hud key must be evicted after commit');

      const hudAfter = await gamificationService.getHud(testTenantId, user.id);
      assert.equal(hudAfter.xp, 30);
    } finally {
      cache.del = origDel;
    }
  });
});
