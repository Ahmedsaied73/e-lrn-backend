'use strict';

const prisma = require('../../config/db');
const config = require('../../config/env');
const cache = require('../../integrations/redis/cache');
const { isValidSlug } = require('../../utils/slugs');
const { resolveAttemptKey, resolveAttemptSurvey } = require('../../utils/quizKeyResolver');
const {
  LEVEL_NAMES,
  XP_WEIGHTS,
  BADGE_DEFINITIONS,
  GRADE_LABELS,
  levelOf,
  progressOf,
  cairoDayKey,
  previousCairoDayKey,
} = require('./gamification.constants');
const gamifyCache = require('./gamification.cache');

function getTenantId(_req) {
  return (config.gamification && config.gamification.tenantId) || 'default';
}

function getEnvGamificationDefault() {
  return Boolean(config.features && config.features.gamification);
}

async function isGamificationEnabled(tenantId = getTenantId()) {
  try {
    const enabled = await cache.withCache(
      gamifyCache.flagKey(tenantId),
      gamifyCache.FLAG_TTL_SEC,
      async () => {
        const row = await prisma.teacherSettings.findUnique({
          where: { tenantId },
          select: { gamificationEnabled: true },
        });
        if (row) return Boolean(row.gamificationEnabled);
        return getEnvGamificationDefault();
      }
    );
    return Boolean(enabled);
  } catch {
    return getEnvGamificationDefault();
  }
}

function checkAccess(enrollment) {
  const { checkEnrollmentAccess } = require('../../services/quizService');
  return checkEnrollmentAccess(enrollment);
}

function evaluateBadgeCodes(stats) {
  const level = levelOf(stats.totalXp);
  const unlocked = [];
  if (stats.completedLessonsCnt >= 1) unlocked.push('first');
  if (stats.currentStreak >= 7) unlocked.push('week');
  if (stats.perfectQuizzesCnt >= 1) unlocked.push('perfect');
  if (stats.completedCoursesCnt >= 1) unlocked.push('steady');
  if (stats.completedQuizzesCnt >= 3) unlocked.push('hunter');
  if (stats.improvedQuizzesCnt >= 1) unlocked.push('learner');
  if (stats.passedChallengesCnt >= 1) unlocked.push('master');
  if (stats.totalXp >= 300) unlocked.push('momentum');
  if (level >= 5) unlocked.push('star');
  return unlocked;
}

function badgeProgressValue(badgeId, profile) {
  if (!profile) return 0;
  switch (badgeId) {
    case 'first':
      return profile.completedLessonsCnt || 0;
    case 'week':
      return profile.currentStreak || 0;
    case 'perfect':
      return profile.perfectQuizzesCnt || 0;
    case 'steady':
      return profile.completedCoursesCnt || 0;
    case 'hunter':
      return profile.completedQuizzesCnt || 0;
    case 'learner':
      return profile.improvedQuizzesCnt || 0;
    case 'master':
      return profile.passedChallengesCnt || 0;
    case 'momentum':
      return profile.totalXp || 0;
    case 'star':
      return levelOf(profile.totalXp || 0);
    default:
      return 0;
  }
}

async function lockOrCreateProfile(tx, tenantId, studentId) {
  await tx.studentGamification.createMany({
    data: [{ tenantId, studentId }],
    skipDuplicates: true,
  });

  await tx.$queryRaw`
    SELECT id FROM "StudentGamification"
    WHERE "tenantId" = ${tenantId} AND "studentId" = ${studentId}
    FOR UPDATE
  `;

  return tx.studentGamification.findUnique({
    where: { tenantId_studentId: { tenantId, studentId } },
  });
}

async function insertEventIdempotent(tx, eventData) {
  const res = await tx.xpEvent.createMany({
    data: [eventData],
    skipDuplicates: true,
  });
  return res.count > 0;
}

async function unlockNewBadgesTx(tx, tenantId, studentId, stats) {
  const qualified = evaluateBadgeCodes(stats);
  if (qualified.length === 0) return [];

  const existing = await tx.studentBadge.findMany({
    where: { tenantId, studentId, badgeCode: { in: qualified } },
    select: { badgeCode: true },
  });
  const existingSet = new Set(existing.map((b) => b.badgeCode));
  const missing = qualified.filter((code) => !existingSet.has(code));
  if (missing.length === 0) return [];

  await tx.studentBadge.createMany({
    data: missing.map((badgeCode) => ({ tenantId, studentId, badgeCode })),
    skipDuplicates: true,
  });

  return missing;
}

function evaluateAttemptQuestions(answerKey, surveyJson, responses, essayFeedback) {
  const orderedNames = [];
  const seen = new Set();

  if (surveyJson && Array.isArray(surveyJson.pages)) {
    for (const page of surveyJson.pages) {
      if (!Array.isArray(page.elements)) continue;
      for (const el of page.elements) {
        if (el && el.name && answerKey && answerKey[el.name] && !seen.has(el.name)) {
          orderedNames.push(el.name);
          seen.add(el.name);
        }
      }
    }
  }
  for (const qName of Object.keys(answerKey || {})) {
    if (!seen.has(qName)) {
      orderedNames.push(qName);
      seen.add(qName);
    }
  }

  let correct = 0;
  let total = 0;
  let currentRun = 0;
  let maxConsecutiveCorrect = 0;
  const questionCorrectMap = new Map();

  for (const qName of orderedNames) {
    const entry = answerKey[qName];
    if (!entry || (entry.type !== 'radiogroup' && entry.type !== 'comment')) continue;

    total += 1;
    let isCorrect = false;
    if (entry.type === 'radiogroup') {
      const studentVal = responses ? responses[qName] : undefined;
      isCorrect = studentVal !== undefined && String(studentVal) === String(entry.correctValue);
    } else if (entry.type === 'comment') {
      const fb = essayFeedback ? essayFeedback[qName] : null;
      const awarded = fb && typeof fb.awarded === 'number' ? fb.awarded : 0;
      const maxPts = Number(entry.points) || 0;
      isCorrect = maxPts > 0 ? awarded >= maxPts * 0.5 : true;
    }

    questionCorrectMap.set(qName, isCorrect);
    if (isCorrect) {
      correct += 1;
      currentRun += 1;
      if (currentRun > maxConsecutiveCorrect) maxConsecutiveCorrect = currentRun;
    } else {
      currentRun = 0;
    }
  }

  return { correct, total, maxConsecutiveCorrect, questionCorrectMap };
}

async function awardForLessonComplete({
  tenantId = getTenantId(),
  studentId,
  lessonId,
  courseId,
  lessonTitle,
  videoSlug,
  watchPercent,
}) {
  if (!studentId || !lessonId) return null;

  const enabled = await isGamificationEnabled(tenantId);
  if (!enabled) return null;

  if (watchPercent !== undefined && Number(watchPercent) < 90) {
    return null;
  }

  const video = await prisma.bunnyVideo.findUnique({
    where: { id: lessonId },
    select: { id: true, slug: true, title: true, courseId: true, status: true },
  });
  if (!video || video.status !== 'READY') return null;

  const effectiveCourseId = courseId || video.courseId;
  const enrollment = await prisma.enrollment.findFirst({
    where: { userId: studentId, courseId: effectiveCourseId },
    select: { id: true, isPaid: true, expiresAt: true },
  });
  if (!checkAccess(enrollment).ok) return null;

  const todayKey = cairoDayKey();
  const yesterdayKey = previousCairoDayKey(todayKey);

  const txResult = await prisma.$transaction(async (tx) => {
    const profile = await lockOrCreateProfile(tx, tenantId, studentId);
    const lines = [];
    let actualTotalGain = 0;

    const lessonInserted = await insertEventIdempotent(tx, {
      tenantId,
      studentId,
      type: 'LESSON_COMPLETE',
      amount: XP_WEIGHTS.LESSON_COMPLETE,
      label: 'خلّصت الدرس',
      idempotencyKey: `lesson:${lessonId}:complete`,
      meta: {
        lessonId,
        courseId: effectiveCourseId,
        videoSlug: videoSlug || video.slug,
        title: lessonTitle || video.title,
      },
    });
    if (lessonInserted) {
      actualTotalGain += XP_WEIGHTS.LESSON_COMPLETE;
      lines.push({ label: 'خلّصت الدرس', value: XP_WEIGHTS.LESSON_COMPLETE });
    }

    let streakInserted = false;
    if (profile.lastActiveDayKey !== todayKey) {
      streakInserted = await insertEventIdempotent(tx, {
        tenantId,
        studentId,
        type: 'STREAK_DAILY',
        amount: XP_WEIGHTS.STREAK_DAILY,
        label: 'سلسلة المذاكرة، يوم جديد',
        idempotencyKey: `streak:${todayKey}`,
        meta: { dayKey: todayKey, lessonId },
      });
      if (streakInserted) {
        actualTotalGain += XP_WEIGHTS.STREAK_DAILY;
        lines.push({ label: 'سلسلة المذاكرة، يوم جديد', value: XP_WEIGHTS.STREAK_DAILY, accent: true });
      }
    }

    if (!lessonInserted && !streakInserted) {
      return null;
    }

    const [totalReady, completedReady] = await Promise.all([
      tx.bunnyVideo.count({ where: { courseId: effectiveCourseId, status: 'READY' } }),
      tx.bunnyVideoProgress.count({
        where: { userId: studentId, completed: true, bunnyVideo: { courseId: effectiveCourseId, status: 'READY' } },
      }),
    ]);

    let completedCoursesDelta = 0;
    if (lessonInserted && totalReady > 0 && completedReady >= totalReady) {
      completedCoursesDelta = 1;
    }

    const newStreak = streakInserted
      ? (profile.lastActiveDayKey === yesterdayKey ? profile.currentStreak + 1 : 1)
      : profile.currentStreak;
    const newLongestStreak = Math.max(profile.longestStreak, newStreak);
    const newLastActiveDayKey = streakInserted ? todayKey : profile.lastActiveDayKey;

    const newTotalXp = profile.totalXp + actualTotalGain;
    const newCompletedLessonsCnt = profile.completedLessonsCnt + (lessonInserted ? 1 : 0);
    const newCompletedCoursesCnt = profile.completedCoursesCnt + completedCoursesDelta;

    const oldLevel = levelOf(profile.totalXp);
    const newLevel = levelOf(newTotalXp);
    const levelUp = newLevel > oldLevel ? newLevel : null;

    const updatedStats = {
      totalXp: newTotalXp,
      currentStreak: newStreak,
      completedLessonsCnt: newCompletedLessonsCnt,
      completedQuizzesCnt: profile.completedQuizzesCnt,
      perfectQuizzesCnt: profile.perfectQuizzesCnt,
      improvedQuizzesCnt: profile.improvedQuizzesCnt,
      passedChallengesCnt: profile.passedChallengesCnt,
      completedCoursesCnt: newCompletedCoursesCnt,
    };

    const unlockedBadges = await unlockNewBadgesTx(tx, tenantId, studentId, updatedStats);

    await tx.studentGamification.update({
      where: { id: profile.id },
      data: {
        totalXp: newTotalXp,
        currentStreak: newStreak,
        longestStreak: newLongestStreak,
        lastActiveDayKey: newLastActiveDayKey,
        completedLessonsCnt: newCompletedLessonsCnt,
        completedCoursesCnt: newCompletedCoursesCnt,
      },
    });

    return {
      eventId: Date.now(),
      kind: 'lesson',
      refId: videoSlug || video.slug || String(lessonId),
      title: lessonTitle || video.title || '',
      lines,
      totalGain: actualTotalGain,
      newTotalXp,
      newStreak,
      levelUp,
      unlockedBadges,
      challengeResult: 'none',
      correct: 0,
      count: 0,
      pct: 0,
      prevBest: null,
      completedLessonsCount: completedReady,
      totalLessonsCount: totalReady,
    };
  });

  if (txResult) {
    await gamifyCache.invalidateStudentCaches(tenantId, studentId);
  }

  return txResult;
}

async function awardForQuizSubmit(params) {
  const {
    tenantId = getTenantId(),
    studentId,
    attemptId,
  } = params || {};

  if (!studentId || !attemptId) return null;

  const enabled = await isGamificationEnabled(tenantId);
  if (!enabled) return null;

  const attempt = await prisma.quizAttempt.findUnique({
    where: { id: attemptId },
    include: {
      quiz: {
        include: {
          bunnyVideo: { select: { id: true, slug: true, courseId: true } },
        },
      },
    },
  });

  if (!attempt || attempt.userId !== studentId || attempt.status !== 'GRADED' || !attempt.quiz) {
    return null;
  }

  const quiz = attempt.quiz;
  const quizId = params.quizId || quiz.id;
  const quizSlug = params.quizSlug || quiz.slug;
  const courseId = params.courseId || (quiz.bunnyVideo && quiz.bunnyVideo.courseId) || null;
  const title = params.title || quiz.title || '';

  const answerKey = params.answerKey || resolveAttemptKey(attempt);
  const surveyJson = resolveAttemptSurvey(attempt);
  const responses = params.responses || attempt.responses || {};
  const evalNow = evaluateAttemptQuestions(answerKey, surveyJson, responses, attempt.essayFeedback);

  const correct = typeof params.correct === 'number' ? params.correct : evalNow.correct;
  const total = typeof params.total === 'number' ? params.total : evalNow.total;
  const pct = typeof params.pct === 'number'
    ? Math.round(params.pct)
    : Math.round(attempt.scorePercent || 0);

  const previousAttempts = await prisma.quizAttempt.findMany({
    where: {
      userId: studentId,
      quizId,
      status: 'GRADED',
      id: { not: attemptId },
    },
    orderBy: { attemptNumber: 'asc' },
    select: {
      id: true,
      attemptNumber: true,
      scorePercent: true,
      responses: true,
      essayFeedback: true,
      quizSnapshot: true,
    },
  });

  let prevBestPct = null;
  let prevBestCorrect = 0;
  let firstAttemptPct = null;
  let prevWrongQuestions = [];

  if (previousAttempts.length > 0) {
    firstAttemptPct = Math.round(previousAttempts[0].scorePercent || 0);
    for (const prevAtt of previousAttempts) {
      const pPct = Math.round(prevAtt.scorePercent || 0);
      if (prevBestPct === null || pPct > prevBestPct) {
        prevBestPct = pPct;
      }
      const prevKey = resolveAttemptKey({ quizSnapshot: prevAtt.quizSnapshot, quiz });
      const prevSurvey = resolveAttemptSurvey({ quizSnapshot: prevAtt.quizSnapshot, quiz });
      const prevEval = evaluateAttemptQuestions(prevKey, prevSurvey, prevAtt.responses || {}, prevAtt.essayFeedback);
      if (prevEval.correct > prevBestCorrect) {
        prevBestCorrect = prevEval.correct;
      }
    }
    const latestPrev = previousAttempts[previousAttempts.length - 1];
    const latestPrevKey = resolveAttemptKey({ quizSnapshot: latestPrev.quizSnapshot, quiz });
    const latestPrevSurvey = resolveAttemptSurvey({ quizSnapshot: latestPrev.quizSnapshot, quiz });
    const latestPrevEval = evaluateAttemptQuestions(
      latestPrevKey,
      latestPrevSurvey,
      latestPrev.responses || {},
      latestPrev.essayFeedback
    );
    prevWrongQuestions = [];
    for (const [qName, ok] of latestPrevEval.questionCorrectMap.entries()) {
      if (!ok) prevWrongQuestions.push(qName);
    }
  }

  const delta = Math.max(0, correct - prevBestCorrect);
  const perfectNow = total > 0 && pct === 100 && (prevBestPct === null || prevBestPct < 100);
  const improved = prevBestPct !== null && pct >= prevBestPct + 10;

  // Teacher challenge evaluation
  let challengeResult = 'none';
  let activeChallenge = null;
  let challenge = null;

  if (courseId) {
    challenge = await prisma.courseChallenge.findUnique({
      where: { courseId },
    });

    if (challenge && challenge.enabled && challenge.tenantId === tenantId) {
      let matchesChallengeQuiz = challenge.quizId !== null && challenge.quizId === quizId;
      if (challenge.quizId === null) {
        const lastVideo = await prisma.bunnyVideo.findFirst({
          where: { courseId, status: 'READY' },
          orderBy: [{ position: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
          select: { quiz: { select: { id: true } } },
        });
        matchesChallengeQuiz = Boolean(lastVideo && lastVideo.quiz && lastVideo.quiz.id === quizId);
      }

      if (matchesChallengeQuiz) {
        const [alreadyPassed, totalReady, completedReady] = await Promise.all([
          prisma.xpEvent.findUnique({
            where: {
              tenantId_studentId_idempotencyKey: {
                tenantId,
                studentId,
                idempotencyKey: `challenge:${courseId}:passed`,
              },
            },
            select: { id: true },
          }),
          prisma.bunnyVideo.count({ where: { courseId, status: 'READY' } }),
          prisma.bunnyVideoProgress.count({
            where: { userId: studentId, completed: true, bunnyVideo: { courseId, status: 'READY' } },
          }),
        ]);

        if (alreadyPassed) {
          challengeResult = 'already';
        } else if (totalReady > 0 && completedReady >= totalReady) {
          let passedChallenge = false;
          switch (challenge.kind) {
            case 'MASTERY':
            case 'NO_SKIP':
            case 'AI_ESSAY':
              passedChallenge = pct >= challenge.masteryPercent;
              break;
            case 'STREAK_ANSWERS':
              passedChallenge =
                evalNow.maxConsecutiveCorrect >= Math.min(5, total) &&
                pct >= challenge.masteryPercent;
              break;
            case 'IMPROVE':
              passedChallenge =
                firstAttemptPct !== null
                  ? pct >= firstAttemptPct + 15 || pct === 100
                  : pct >= challenge.masteryPercent;
              break;
            case 'MISTAKES':
              passedChallenge =
                prevWrongQuestions.length > 0
                  ? prevWrongQuestions.every((q) => evalNow.questionCorrectMap.get(q) === true) &&
                    pct >= challenge.masteryPercent
                  : pct >= challenge.masteryPercent;
              break;
            default:
              passedChallenge = pct >= challenge.masteryPercent;
              break;
          }

          if (passedChallenge) {
            challengeResult = 'passed';
            activeChallenge = challenge;
          } else {
            challengeResult = 'failed';
          }
        }
      }
    }
  }

  const todayKey = cairoDayKey();
  const yesterdayKey = previousCairoDayKey(todayKey);

  const txResult = await prisma.$transaction(async (tx) => {
    const profile = await lockOrCreateProfile(tx, tenantId, studentId);
    const lines = [];
    let actualTotalGain = 0;

    if (delta > 0) {
      const deltaAmount = delta * XP_WEIGHTS.QUIZ_CORRECT_PER_Q;
      const deltaLabel = prevBestPct !== null
        ? `إجابات صح زيادة عن أحسن محاولة: ${delta}`
        : `إجابات صح: ${correct} من ${total}`;
      const inserted = await insertEventIdempotent(tx, {
        tenantId,
        studentId,
        type: 'QUIZ_CORRECT_DELTA',
        amount: deltaAmount,
        label: deltaLabel,
        idempotencyKey: `quiz:${quizId}:attempt:${attemptId}:delta`,
        meta: { attemptId, quizId, delta, correct, total },
      });
      if (inserted) {
        actualTotalGain += deltaAmount;
        lines.push({ label: deltaLabel, value: deltaAmount });
      }
    }

    let perfectInserted = false;
    if (perfectNow) {
      perfectInserted = await insertEventIdempotent(tx, {
        tenantId,
        studentId,
        type: 'QUIZ_PERFECT',
        amount: XP_WEIGHTS.QUIZ_PERFECT,
        label: 'درجة كاملة',
        idempotencyKey: `quiz:${quizId}:perfect`,
        meta: { attemptId, quizId },
      });
      if (perfectInserted) {
        actualTotalGain += XP_WEIGHTS.QUIZ_PERFECT;
        lines.push({ label: 'درجة كاملة', value: XP_WEIGHTS.QUIZ_PERFECT, accent: true });
      }
    }

    let improveInserted = false;
    if (improved) {
      const improveLabel = `تحسّن عن أحسن نتيجة (${prevBestPct}%)`;
      improveInserted = await insertEventIdempotent(tx, {
        tenantId,
        studentId,
        type: 'QUIZ_IMPROVEMENT',
        amount: XP_WEIGHTS.QUIZ_IMPROVEMENT,
        label: improveLabel,
        idempotencyKey: `quiz:${quizId}:improve:${attemptId}`,
        meta: { attemptId, quizId, prevBestPct, pct },
      });
      if (improveInserted) {
        actualTotalGain += XP_WEIGHTS.QUIZ_IMPROVEMENT;
        lines.push({ label: improveLabel, value: XP_WEIGHTS.QUIZ_IMPROVEMENT });
      }
    }

    let challengeInserted = false;
    if (challengeResult === 'passed' && activeChallenge) {
      challengeInserted = await insertEventIdempotent(tx, {
        tenantId,
        studentId,
        type: 'TEACHER_CHALLENGE',
        amount: activeChallenge.rewardXp,
        label: 'إتقان تحدي المدرس',
        idempotencyKey: `challenge:${courseId}:passed`,
        meta: { attemptId, quizId, courseId, kind: activeChallenge.kind },
      });
      if (challengeInserted) {
        actualTotalGain += activeChallenge.rewardXp;
        lines.push({ label: 'إتقان تحدي المدرس', value: activeChallenge.rewardXp, accent: true });
      } else {
        challengeResult = 'already';
      }
    }

    let streakInserted = false;
    if (profile.lastActiveDayKey !== todayKey) {
      streakInserted = await insertEventIdempotent(tx, {
        tenantId,
        studentId,
        type: 'STREAK_DAILY',
        amount: XP_WEIGHTS.STREAK_DAILY,
        label: 'سلسلة المذاكرة، يوم جديد',
        idempotencyKey: `streak:${todayKey}`,
        meta: { dayKey: todayKey, attemptId, quizId },
      });
      if (streakInserted) {
        actualTotalGain += XP_WEIGHTS.STREAK_DAILY;
        lines.push({ label: 'سلسلة المذاكرة، يوم جديد', value: XP_WEIGHTS.STREAK_DAILY, accent: true });
      }
    }

    const gradedQuizzesCount = await tx.quizAttempt.count({
      where: { userId: studentId, status: 'GRADED' },
    });

    const newStreak = streakInserted
      ? (profile.lastActiveDayKey === yesterdayKey ? profile.currentStreak + 1 : 1)
      : profile.currentStreak;
    const newLongestStreak = Math.max(profile.longestStreak, newStreak);
    const newLastActiveDayKey = streakInserted ? todayKey : profile.lastActiveDayKey;

    const newTotalXp = profile.totalXp + actualTotalGain;
    const newCompletedQuizzesCnt = Math.max(profile.completedQuizzesCnt, gradedQuizzesCount);
    const newPerfectQuizzesCnt = profile.perfectQuizzesCnt + (perfectInserted ? 1 : 0);
    const newImprovedQuizzesCnt = profile.improvedQuizzesCnt + (improveInserted ? 1 : 0);
    const newPassedChallengesCnt = profile.passedChallengesCnt + (challengeInserted ? 1 : 0);

    const oldLevel = levelOf(profile.totalXp);
    const newLevel = levelOf(newTotalXp);
    const levelUp = newLevel > oldLevel ? newLevel : null;

    const updatedStats = {
      totalXp: newTotalXp,
      currentStreak: newStreak,
      completedLessonsCnt: profile.completedLessonsCnt,
      completedQuizzesCnt: newCompletedQuizzesCnt,
      perfectQuizzesCnt: newPerfectQuizzesCnt,
      improvedQuizzesCnt: newImprovedQuizzesCnt,
      passedChallengesCnt: newPassedChallengesCnt,
      completedCoursesCnt: profile.completedCoursesCnt,
    };

    const unlockedBadges = await unlockNewBadgesTx(tx, tenantId, studentId, updatedStats);

    await tx.studentGamification.update({
      where: { id: profile.id },
      data: {
        totalXp: newTotalXp,
        currentStreak: newStreak,
        longestStreak: newLongestStreak,
        lastActiveDayKey: newLastActiveDayKey,
        completedQuizzesCnt: newCompletedQuizzesCnt,
        perfectQuizzesCnt: newPerfectQuizzesCnt,
        improvedQuizzesCnt: newImprovedQuizzesCnt,
        passedChallengesCnt: newPassedChallengesCnt,
      },
    });

    return {
      eventId: Date.now(),
      kind: 'quiz',
      refId: quizSlug || String(quizId),
      title,
      lines,
      totalGain: actualTotalGain,
      newTotalXp,
      newStreak,
      levelUp,
      unlockedBadges,
      challengeResult,
      challengeMasteryPercent: activeChallenge ? activeChallenge.masteryPercent : (challenge ? challenge.masteryPercent : 80),
      correct,
      count: total,
      pct,
      prevBest: prevBestPct,
    };
  });

  await gamifyCache.invalidateStudentCaches(tenantId, studentId);
  return txResult;
}

async function getAttemptGamificationAward({
  tenantId = getTenantId(),
  studentId,
  attemptId,
  quizId,
  quizSlug,
  title,
  attempt,
}) {
  if (!studentId || !attemptId) return null;

  const enabled = await isGamificationEnabled(tenantId);
  if (!enabled) return null;

  const recentEvents = await prisma.xpEvent.findMany({
    where: { tenantId, studentId },
    orderBy: { createdAt: 'desc' },
    take: 15,
    select: {
      id: true,
      type: true,
      amount: true,
      label: true,
      idempotencyKey: true,
      meta: true,
    },
  });

  const attemptPrefix = `quiz:${quizId}:attempt:${attemptId}:`;
  const matching = recentEvents.filter((ev) => {
    if (ev.idempotencyKey.startsWith(attemptPrefix)) return true;
    if (ev.idempotencyKey === `quiz:${quizId}:improve:${attemptId}`) return true;
    return Boolean(ev.meta && typeof ev.meta === 'object' && ev.meta.attemptId === attemptId);
  });

  if (matching.length === 0) return null;

  const lines = matching
    .slice()
    .reverse()
    .map((ev) => ({
      label: ev.label,
      value: ev.amount,
      ...(ev.type === 'STREAK_DAILY' || ev.type === 'QUIZ_PERFECT' || ev.type === 'TEACHER_CHALLENGE'
        ? { accent: true }
        : {}),
    }));

  const totalGain = lines.reduce((sum, l) => sum + l.value, 0);
  const challengeEv = matching.find((ev) => ev.type === 'TEACHER_CHALLENGE');
  const profile = await prisma.studentGamification.findUnique({
    where: { tenantId_studentId: { tenantId, studentId } },
    select: { totalXp: true, currentStreak: true },
  });

  let correct = 0;
  let total = 0;
  let pct = 0;
  if (attempt) {
    const answerKey = resolveAttemptKey(attempt);
    const surveyJson = resolveAttemptSurvey(attempt);
    const evalRes = evaluateAttemptQuestions(answerKey, surveyJson, attempt.responses || {}, attempt.essayFeedback);
    correct = evalRes.correct;
    total = evalRes.total;
    pct = Math.round(attempt.scorePercent || 0);
  }

  return {
    eventId: attemptId,
    kind: 'quiz',
    refId: quizSlug || String(quizId),
    title: title || '',
    lines,
    totalGain,
    newTotalXp: profile ? profile.totalXp : totalGain,
    newStreak: profile ? profile.currentStreak : 0,
    levelUp: null,
    unlockedBadges: [],
    challengeResult: challengeEv ? 'passed' : 'none',
    correct,
    count: total,
    pct,
    prevBest: null,
  };
}

async function getHud(tenantId = getTenantId(), studentId) {
  const enabled = await isGamificationEnabled(tenantId);
  if (!enabled) {
    return {
      enabled: false,
      xp: 0,
      level: 1,
      levelName: LEVEL_NAMES[0],
      pct: 0,
      left: 100,
      streak: 0,
      doneToday: false,
    };
  }

  return cache.withCache(gamifyCache.hudKey(tenantId, studentId), gamifyCache.HUD_TTL_SEC, async () => {
    const row = await prisma.studentGamification.findUnique({
      where: { tenantId_studentId: { tenantId, studentId } },
      select: { totalXp: true, currentStreak: true, lastActiveDayKey: true },
    });
    const xp = row ? row.totalXp : 0;
    const streak = row ? row.currentStreak : 0;
    const doneToday = Boolean(row && row.lastActiveDayKey === cairoDayKey());
    const prog = progressOf(xp);
    return {
      enabled: true,
      xp,
      level: prog.level,
      levelName: prog.levelName,
      pct: prog.pct,
      left: prog.left,
      streak,
      doneToday,
    };
  });
}

async function getSummary(tenantId = getTenantId(), studentId) {
  const enabled = await isGamificationEnabled(tenantId);
  if (!enabled) {
    return { enabled: false };
  }

  return cache.withCache(gamifyCache.summaryKey(tenantId, studentId), gamifyCache.SUMMARY_TTL_SEC, async () => {
    const [
      profile,
      unlockedBadges,
      recentEvents,
      enrollments,
      recentAttempts,
      avgAgg,
    ] = await Promise.all([
      prisma.studentGamification.findUnique({
        where: { tenantId_studentId: { tenantId, studentId } },
      }),
      prisma.studentBadge.findMany({
        where: { tenantId, studentId },
        select: { badgeCode: true, unlockedAt: true },
      }),
      prisma.xpEvent.findMany({
        where: { tenantId, studentId },
        take: 6,
        orderBy: { createdAt: 'desc' },
        select: { id: true, type: true, amount: true, label: true, createdAt: true },
      }),
      prisma.enrollment.findMany({
        where: { userId: studentId, course: { deletedAt: null } },
        orderBy: { createdAt: 'desc' },
        select: {
          isPaid: true,
          expiresAt: true,
          course: {
            select: {
              id: true,
              slug: true,
              title: true,
              grade: true,
              challenge: {
                select: {
                  title: true,
                  enabled: true,
                  quizId: true,
                  quiz: { select: { slug: true, bunnyVideo: { select: { slug: true } } } },
                },
              },
            },
          },
        },
      }),
      prisma.quizAttempt.findMany({
        where: { userId: studentId, status: 'GRADED' },
        take: 5,
        orderBy: { submittedAt: 'desc' },
        select: {
          id: true,
          scorePercent: true,
          earnedPoints: true,
          totalPoints: true,
          submittedAt: true,
          responses: true,
          essayFeedback: true,
          quizSnapshot: true,
          quiz: {
            select: {
              id: true,
              slug: true,
              title: true,
              answerKey: true,
              bunnyVideo: {
                select: {
                  slug: true,
                  courseId: true,
                  course: {
                    select: {
                      slug: true,
                      challenge: {
                        select: {
                          enabled: true,
                          quizId: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      prisma.quizAttempt.aggregate({
        where: { userId: studentId, status: 'GRADED', scorePercent: { not: null } },
        _avg: { scorePercent: true },
      }),
    ]);

    const activeEnrollments = enrollments.filter((e) => checkAccess(e).ok);
    const courseIds = activeEnrollments.map((e) => e.course.id);

    let totalVideosByCourse = new Map();
    let completedVideosByCourse = new Map();
    let passedChallengeKeys = new Set();
    let nextUncompletedVideo = null;

    if (courseIds.length > 0) {
      const [videoGroups, completedProgressRows, passedChallengeEvents] = await Promise.all([
        prisma.bunnyVideo.groupBy({
          by: ['courseId'],
          where: { status: 'READY', courseId: { in: courseIds } },
          _count: { _all: true },
        }),
        prisma.bunnyVideoProgress.findMany({
          where: {
            userId: studentId,
            completed: true,
            bunnyVideo: { status: 'READY', courseId: { in: courseIds } },
          },
          select: {
            bunnyVideoId: true,
            bunnyVideo: { select: { courseId: true } },
          },
        }),
        prisma.xpEvent.findMany({
          where: {
            tenantId,
            studentId,
            idempotencyKey: { in: courseIds.map((id) => `challenge:${id}:passed`) },
          },
          select: { idempotencyKey: true },
        }),
      ]);

      totalVideosByCourse = new Map(videoGroups.map((g) => [g.courseId, g._count._all]));
      completedVideosByCourse = new Map();
      const completedVideoIds = [];
      for (const row of completedProgressRows) {
        completedVideoIds.push(row.bunnyVideoId);
        const cId = row.bunnyVideo.courseId;
        completedVideosByCourse.set(cId, (completedVideosByCourse.get(cId) || 0) + 1);
      }
      passedChallengeKeys = new Set(passedChallengeEvents.map((e) => e.idempotencyKey));

      nextUncompletedVideo = await prisma.bunnyVideo.findFirst({
        where: {
          status: 'READY',
          courseId: { in: courseIds },
          ...(completedVideoIds.length > 0 ? { id: { notIn: completedVideoIds } } : {}),
        },
        orderBy: [{ courseId: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: {
          slug: true,
          title: true,
          course: { select: { slug: true } },
        },
      });
    }

    const courses = activeEnrollments.map(({ course }) => {
      const totalVideos = totalVideosByCourse.get(course.id) || 0;
      const completedVideos = Math.min(totalVideos, completedVideosByCourse.get(course.id) || 0);
      const pct = totalVideos > 0 ? Math.round((completedVideos / totalVideos) * 100) : 0;
      return {
        courseSlug: course.slug,
        title: course.title,
        grade: GRADE_LABELS[course.grade] || course.grade,
        totalVideos,
        completedVideos,
        pct,
      };
    });

    // Determine smart nextAction: open unpassed challenge first, then next lesson, else courses
    let nextAction = {
      type: 'courses',
      title: 'تصفّح الدورات',
      courseSlug: courses[0] ? courses[0].courseSlug : null,
    };

    const openChallengeCourse = activeEnrollments.find(({ course }) => {
      if (!course.challenge || !course.challenge.enabled) return false;
      const total = totalVideosByCourse.get(course.id) || 0;
      const completed = completedVideosByCourse.get(course.id) || 0;
      if (total === 0 || completed < total) return false;
      return !passedChallengeKeys.has(`challenge:${course.id}:passed`);
    });

    if (openChallengeCourse) {
      let quizSlug = openChallengeCourse.course.challenge.quiz
        ? openChallengeCourse.course.challenge.quiz.slug
        : null;
      let videoSlug =
        openChallengeCourse.course.challenge.quiz &&
        openChallengeCourse.course.challenge.quiz.bunnyVideo
          ? openChallengeCourse.course.challenge.quiz.bunnyVideo.slug
          : null;
      if (!quizSlug) {
        const lastVideo = await prisma.bunnyVideo.findFirst({
          where: { courseId: openChallengeCourse.course.id, status: 'READY' },
          orderBy: [{ position: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
          select: { slug: true, quiz: { select: { slug: true } } },
        });
        videoSlug = lastVideo ? lastVideo.slug : null;
        quizSlug = lastVideo && lastVideo.quiz ? lastVideo.quiz.slug : null;
      }
      nextAction = {
        type: 'challenge',
        title: openChallengeCourse.course.challenge.title,
        courseSlug: openChallengeCourse.course.slug,
        ...(videoSlug ? { videoSlug } : {}),
        ...(quizSlug ? { quizSlug } : {}),
      };
    } else if (nextUncompletedVideo) {
      nextAction = {
        type: 'lesson',
        title: nextUncompletedVideo.title,
        courseSlug: nextUncompletedVideo.course.slug,
        videoSlug: nextUncompletedVideo.slug,
      };
    }

    const fallbackChallengeCourseIds = new Set();
    for (const att of recentAttempts) {
      const bv = att.quiz && att.quiz.bunnyVideo;
      const ch = bv && bv.course && bv.course.challenge;
      if (ch && ch.enabled && ch.quizId === null && bv.courseId) {
        fallbackChallengeCourseIds.add(bv.courseId);
      }
    }
    const lastVideoQuizIdByCourse = new Map();
    if (fallbackChallengeCourseIds.size > 0) {
      const lastVideos = await Promise.all(
        Array.from(fallbackChallengeCourseIds).map(async (cId) => {
          const v = await prisma.bunnyVideo.findFirst({
            where: { courseId: cId, status: 'READY' },
            orderBy: [{ position: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
            select: { quiz: { select: { id: true } } },
          });
          return [cId, v && v.quiz ? v.quiz.id : null];
        })
      );
      for (const [cId, qId] of lastVideos) {
        if (qId !== null) lastVideoQuizIdByCourse.set(cId, qId);
      }
    }

    const exams = recentAttempts.map((att) => {
      const answerKey = resolveAttemptKey(att);
      const evalRes = evaluateAttemptQuestions(answerKey, null, att.responses || {}, att.essayFeedback);
      const pct = Math.round(att.scorePercent || 0);
      const bv = att.quiz.bunnyVideo;
      const course = bv ? bv.course : null;
      const ch = course ? course.challenge : null;
      let isChallenge = false;
      if (ch && ch.enabled) {
        if (ch.quizId !== null) {
          isChallenge = ch.quizId === att.quiz.id;
        } else if (bv && bv.courseId) {
          isChallenge = lastVideoQuizIdByCourse.get(bv.courseId) === att.quiz.id;
        }
      }
      const date = att.submittedAt
        ? new Date(att.submittedAt).toLocaleDateString('ar-EG', { month: 'short', day: 'numeric' })
        : 'الآن';
      return {
        id: String(att.id),
        quizSlug: att.quiz.slug,
        videoSlug: bv ? bv.slug : null,
        courseSlug: course ? course.slug : null,
        title: att.quiz.title,
        correct: evalRes.correct,
        count: evalRes.total,
        pct,
        date,
        isChallenge,
        submittedAt: att.submittedAt,
      };
    });

    const xp = profile ? profile.totalXp : 0;
    const streak = profile ? profile.currentStreak : 0;
    const doneToday = Boolean(profile && profile.lastActiveDayKey === cairoDayKey());
    const prog = progressOf(xp);

    const unlockedMap = new Map(unlockedBadges.map((b) => [b.badgeCode, b.unlockedAt]));
    const badges = BADGE_DEFINITIONS.map((def) => {
      const unlockedAt = unlockedMap.get(def.id) || null;
      const unlocked = Boolean(unlockedAt);
      const current = unlocked ? def.target : Math.min(def.target, badgeProgressValue(def.id, profile));
      return {
        id: def.id,
        title: def.title,
        how: def.how,
        where: def.where,
        target: def.target,
        tone: def.tone,
        unlocked,
        unlockedAt,
        current,
      };
    });

    return {
      enabled: true,
      hud: {
        enabled: true,
        xp,
        level: prog.level,
        levelName: prog.levelName,
        pct: prog.pct,
        left: prog.left,
        streak,
        doneToday,
      },
      courses,
      exams,
      averageExamPct: Math.round(avgAgg._avg.scorePercent || 0),
      badges,
      log: recentEvents.map((ev) => ({
        id: ev.id,
        label: ev.label,
        gain: ev.amount,
        createdAt: ev.createdAt,
      })),
      nextAction,
    };
  });
}

async function getCourseChallenge(tenantId = getTenantId(), studentId, courseSlug, isUserAdmin = false) {
  if (!isValidSlug(courseSlug)) {
    throw Object.assign(new Error('Invalid course slug'), { statusCode: 400 });
  }

  const course = await prisma.course.findUnique({
    where: { slug: courseSlug, deletedAt: null },
    select: { id: true, slug: true, title: true },
  });
  if (!course) {
    throw Object.assign(new Error('Course not found'), { statusCode: 404 });
  }

  if (!isUserAdmin) {
    const enrollment = await prisma.enrollment.findFirst({
      where: { userId: studentId, courseId: course.id },
      select: { id: true, isPaid: true, expiresAt: true },
    });
    const access = checkAccess(enrollment);
    if (!access.ok) {
      throw Object.assign(new Error(access.reason), { statusCode: 403, code: access.code });
    }
  }

  const enabled = await isGamificationEnabled(tenantId);
  if (!enabled) {
    return {
      enabled: false,
      configured: false,
      courseSlug: course.slug,
      kind: 'MASTERY',
      title: '',
      rule: '',
      masteryPercent: 80,
      rewardXp: 120,
      quizSlug: null,
      videoSlug: null,
      status: 'locked',
      remainingLessons: 0,
    };
  }

  const [challenge, totalVideos, completedVideos, passedEvent] = await Promise.all([
    prisma.courseChallenge.findUnique({
      where: { courseId: course.id },
      include: {
        quiz: {
          select: {
            id: true,
            slug: true,
            bunnyVideo: { select: { slug: true } },
          },
        },
      },
    }),
    prisma.bunnyVideo.count({ where: { courseId: course.id, status: 'READY' } }),
    prisma.bunnyVideoProgress.count({
      where: { userId: studentId, completed: true, bunnyVideo: { courseId: course.id, status: 'READY' } },
    }),
    prisma.xpEvent.findUnique({
      where: {
        tenantId_studentId_idempotencyKey: {
          tenantId,
          studentId,
          idempotencyKey: `challenge:${course.id}:passed`,
        },
      },
      select: { id: true },
    }),
  ]);

  const remainingLessons = Math.max(0, totalVideos - completedVideos);
  const configured = Boolean(challenge && challenge.tenantId === tenantId);

  if (!configured) {
    return {
      enabled: false,
      configured: false,
      courseSlug: course.slug,
      kind: 'MASTERY',
      title: '',
      rule: '',
      masteryPercent: 80,
      rewardXp: 120,
      quizSlug: null,
      videoSlug: null,
      status: 'locked',
      remainingLessons,
    };
  }

  let quizSlug = challenge.quiz ? challenge.quiz.slug : null;
  let videoSlug = challenge.quiz && challenge.quiz.bunnyVideo ? challenge.quiz.bunnyVideo.slug : null;
  if (!quizSlug) {
    const lastVideo = await prisma.bunnyVideo.findFirst({
      where: { courseId: course.id, status: 'READY' },
      orderBy: [{ position: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      select: { slug: true, quiz: { select: { slug: true } } },
    });
    videoSlug = lastVideo ? lastVideo.slug : null;
    quizSlug = lastVideo && lastVideo.quiz ? lastVideo.quiz.slug : null;
  }

  let status = 'locked';
  if (passedEvent) {
    status = 'done';
  } else if (challenge.enabled && totalVideos > 0 && remainingLessons === 0) {
    status = 'open';
  }

  return {
    enabled: Boolean(enabled && challenge.tenantId === tenantId && challenge.enabled),
    configured: true,
    courseSlug: course.slug,
    kind: challenge.kind,
    title: challenge.title,
    rule: challenge.rule,
    masteryPercent: challenge.masteryPercent,
    rewardXp: challenge.rewardXp,
    quizSlug: quizSlug || null,
    videoSlug: videoSlug || null,
    status,
    remainingLessons,
  };
}

async function upsertCourseChallenge(tenantId = getTenantId(), courseSlug, input) {
  if (!isValidSlug(courseSlug)) {
    throw Object.assign(new Error('Invalid course slug'), { statusCode: 400 });
  }

  const course = await prisma.course.findUnique({
    where: { slug: courseSlug, deletedAt: null },
    select: { id: true, slug: true },
  });
  if (!course) {
    throw Object.assign(new Error('Course not found'), { statusCode: 404 });
  }

  let quiz = null;
  if (input.quizSlug) {
    quiz = await prisma.quiz.findUnique({
      where: { slug: input.quizSlug },
      select: {
        id: true,
        slug: true,
        bunnyVideo: { select: { courseId: true, slug: true } },
      },
    });
    if (!quiz) {
      throw Object.assign(new Error('Quiz not found'), { statusCode: 404 });
    }
    if (!quiz.bunnyVideo || quiz.bunnyVideo.courseId !== course.id) {
      throw Object.assign(new Error('Quiz does not belong to this course'), { statusCode: 403 });
    }
  }

  const saved = await prisma.courseChallenge.upsert({
    where: { courseId: course.id },
    create: {
      tenantId,
      courseId: course.id,
      kind: input.kind,
      quizId: quiz ? quiz.id : null,
      title: input.title,
      rule: input.rule,
      masteryPercent: input.masteryPercent,
      rewardXp: input.rewardXp,
      enabled: input.enabled,
    },
    update: {
      tenantId,
      kind: input.kind,
      quizId: quiz ? quiz.id : null,
      title: input.title,
      rule: input.rule,
      masteryPercent: input.masteryPercent,
      rewardXp: input.rewardXp,
      enabled: input.enabled,
    },
  });

  return {
    enabled: saved.enabled,
    configured: true,
    courseSlug: course.slug,
    kind: saved.kind,
    title: saved.title,
    rule: saved.rule,
    masteryPercent: saved.masteryPercent,
    rewardXp: saved.rewardXp,
    quizSlug: quiz ? quiz.slug : null,
    videoSlug: quiz && quiz.bunnyVideo ? quiz.bunnyVideo.slug : null,
    status: 'locked',
    remainingLessons: 0,
    updatedAt: saved.updatedAt,
  };
}

module.exports = {
  getTenantId,
  isGamificationEnabled,
  awardForLessonComplete,
  awardForQuizSubmit,
  getAttemptGamificationAward,
  getHud,
  getSummary,
  getCourseChallenge,
  upsertCourseChallenge,
};
