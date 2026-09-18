'use strict';

/**
 * quizController.js
 * Thin HTTP adapters for Quiz endpoints.
 * Handles request parsing, authentication context, calls quizService, and formats responses.
 */

const prisma = require('../config/db');
const quizService = require('../services/quizService');
const { STATUS } = require('../config/quizConfig');
const cache = require('../integrations/redis/cache');
const busboy = require('busboy');
const crypto = require('crypto');
const audit = require('../services/auditLog');
const { isValidSlug, randomBase36Slug } = require('../utils/slugs');

function parseInteger(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Resolve a BunnyVideo by public slug (returns null for bad slug / missing row). */
async function resolveVideoBySlug(slug) {
  if (!isValidSlug(slug)) return null;
  return prisma.bunnyVideo.findUnique({ where: { slug } });
}

// ─── Student Endpoints ────────────────────────────────────────────────────────

/**
 * GET /quizzes/videos/:videoId/meta
 * Returns metadata driving the "بدء الاختبار" button:
 * exists, unlocked (video completed), attempted, passed, bestScore, timeLimitSec, inProgressAttempt
 */
async function getQuizMeta(req, res) {
  try {
    const { videoSlug } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const video = await resolveVideoBySlug(videoSlug);
    if (!video) {
      return res.status(404).json({ success: false, error: 'Video not found' });
    }
    const videoId = video.id;

    // Per-user 30s cache (key includes userId — no cross-user leakage).
    // Invalidated on start/submit/grade/reset/complete/exemption change.
    // Cached bodies are wire-identical to fresh ones (same res.json path).
    const metaKey = cache.buildKey('quiz', 'meta', userId, videoId);
    const cachedMeta = await cache.get(metaKey);
    if (cachedMeta) {
      return res.status(200).json({ success: true, data: cachedMeta });
    }

    const videoRow = await prisma.bunnyVideo.findUnique({
      where: { id: videoId },
      include: {
        quiz: true,
        course: { select: { slug: true } },
      },
    });

    const quiz = videoRow.quiz;

    // Independent reads issued in parallel (was 3 serial round trips):
    // enrollment (non-admin), completion flag (non-admin), attempt history.
    // The original precedence is preserved below (403 before exists:false) —
    // parallelism changes timing only.
    const [enrollment, progress, attempts] = await Promise.all([
      userRole === 'ADMIN'
        ? null
        : prisma.enrollment.findFirst({ where: { userId, courseId: videoRow.courseId } }),
      userRole === 'ADMIN' || !videoRow.quiz
        ? null
        : prisma.bunnyVideoProgress.findFirst({ where: { userId, bunnyVideoId: videoId, completed: true } }),
      videoRow.quiz
        ? prisma.quizAttempt.findMany({
            where: { userId, quizId: quiz.id },
            orderBy: { attemptNumber: 'desc' },
            select: {
              id: true,
              attemptNumber: true,
              status: true,
              startedAt: true,
              deadlineAt: true,
              submittedAt: true,
              scorePercent: true,
              earnedPoints: true,
              totalPoints: true,
            },
          })
        : [],
    ]);

    // Check enrollment if student
    if (userRole !== 'ADMIN' && !enrollment) {
      return res.status(403).json({ success: false, error: 'You are not enrolled in this course' });
    }

    if (!videoRow.quiz) {
      const data = { exists: false, videoSlug: videoRow.slug, videoTitle: videoRow.title };
      await cache.set(metaKey, data, 30);
      return res.status(200).json({ success: true, data });
    }

    // Check if video is completed (unlock signal for quiz)
    const videoCompleted = userRole === 'ADMIN' ? true : !!progress;

    const inProgressAttempt = attempts.find(a => a.status === STATUS.IN_PROGRESS) || null;
    const gradedAttempts = attempts.filter(a => a.status === STATUS.GRADED);
    const bestScore = gradedAttempts.length > 0
      ? Math.max(...gradedAttempts.map(a => a.scorePercent || 0))
      : null;
    const passed = bestScore !== null && bestScore >= quiz.passingScore;

    // Retake limiter — EXPIRED attempts (network drops/timeouts) don't burn a retake
    const maxAttempts = quiz.maxAttempts;
    const attemptsUsed = attempts.filter(a => a.status !== STATUS.EXPIRED).length;
    const atMaxAttempts = attemptsUsed >= maxAttempts;

    // Question/points tallies for the intro card
    const totalQuestions = quizService.countQuestions(quiz.surveyJson);
    const { totalPoints } = quizService.computeTotalPoints(quiz.answerKey || {});

    const metaData = {
      exists: true,
      quizSlug: quiz.slug,
      videoSlug: videoRow.slug,
      videoTitle: videoRow.title,
      title: quiz.title,
      timeLimitSec: quiz.timeLimitSec,
      passingScore: quiz.passingScore,
      maxAttempts,
      attemptsUsed,
      atMaxAttempts,
      unlocked: videoCompleted,
      attempted: attempts.length > 0,
      totalAttempts: attempts.length,
      passed,
      bestScore,
      totalQuestions,
      totalPoints,
      inProgressAttempt: inProgressAttempt ? {
        id: inProgressAttempt.id,
        attemptNumber: inProgressAttempt.attemptNumber,
        deadlineAt: inProgressAttempt.deadlineAt,
      } : null,
    };
    await cache.set(metaKey, metaData, 30);

    return res.status(200).json({
      success: true,
      data: metaData,
    });
  } catch (error) {
    console.error('[QuizController] getQuizMeta error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * POST /quizzes/videos/:videoId/start
 * Starts a new attempt or resumes an active IN_PROGRESS attempt.
 * Returns sanitized surveyJson and deadlineAt.
 */
async function startQuiz(req, res) {
  try {
    const { videoSlug } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const video = await resolveVideoBySlug(videoSlug);
    if (!video) {
      return res.status(404).json({ success: false, error: 'Video not found' });
    }
    const videoId = video.id;

    const videoRow = await prisma.bunnyVideo.findUnique({
      where: { id: videoId },
      include: { quiz: true },
    });

    if (!videoRow || !videoRow.quiz) {
      return res.status(404).json({ success: false, error: 'No quiz found for this video' });
    }

    // Check enrollment and video completion for students — independent reads
    // issued in parallel (was 2 serial round trips). Error precedence
    // (enrollment before completion) is preserved below.
    if (userRole !== 'ADMIN') {
      const [enrollment, progress] = await Promise.all([
        prisma.enrollment.findFirst({ where: { userId, courseId: videoRow.courseId } }),
        prisma.bunnyVideoProgress.findFirst({ where: { userId, bunnyVideoId: videoId, completed: true } }),
      ]);
      if (!enrollment) {
        return res.status(403).json({ success: false, error: 'You are not enrolled in this course' });
      }

      if (!progress) {
        return res.status(403).json({ success: false, error: 'You must complete the video before taking the quiz' });
      }
    }

const { attempt, quiz, resumed } = await quizService.startAttempt(userId, videoRow.quiz.id, {
      bypassPassedCheck: userRole === 'ADMIN',
    });
    const safeQuiz = quizService.sanitizeForStudent(quiz);
    safeQuiz.videoSlug = videoSlug;

    return res.status(200).json({
      success: true,
      data: {
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        status: attempt.status,
        startedAt: attempt.startedAt,
        deadlineAt: attempt.deadlineAt,
        resumed,
        responses: resumed ? attempt.responses || null : null,
        quiz: safeQuiz,
      },
    });
  } catch (error) {
    console.error('[QuizController] startQuiz error:', error);
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ success: false, error: error.message, code: error.code });
  }
}

/**
 * PATCH /quizzes/attempts/:id/save
 * Saves responses for an in-progress owned attempt without grading it.
 */
async function saveQuizAttempt(req, res) {
  try {
    const attemptId = parseInteger(req.params.id);
    const userId = req.user.id;
    const { responses } = req.body || {};

    if (attemptId === null || attemptId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid attempt ID' });
    }

    if (!responses || typeof responses !== 'object' || Array.isArray(responses)) {
      return res.status(400).json({ success: false, error: 'responses must be an object map of question responses' });
    }

    const saved = await quizService.saveAttempt(userId, attemptId, responses);
    return res.status(200).json({
      success: true,
      data: { attemptId: saved.id, saved: true },
    });
  } catch (error) {
    console.error('[QuizController] saveQuizAttempt error:', error);
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ success: false, error: error.message || 'Unable to save attempt' });
  }
}

/**
 * POST /quizzes/attempts/:id/submit
 * Submits student responses for an attempt. Auto-grades MCQs and enforces deadlines.
 */
async function submitQuiz(req, res) {
  try {
    const attemptId = parseInteger(req.params.id);
    const userId = req.user.id;
    const { answers, autoSubmitted } = req.body;

    if (attemptId === null || attemptId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid attempt ID' });
    }

    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      return res.status(400).json({ success: false, error: 'answers must be an object map of question responses' });
    }

    const result = await quizService.submitAttempt(userId, attemptId, answers, !!autoSubmitted);

    return res.status(200).json({
      success: true,
      data: {
        attemptId: result.attempt.id,
        status: result.attempt.status,
        earnedPoints: result.attempt.earnedPoints,
        totalPoints: result.attempt.totalPoints,
        scorePercent: result.attempt.scorePercent,
        hasEssays: result.hasEssays,
        perQuestion: result.perQuestion,
      },
    });
  } catch (error) {
    console.error('[QuizController] submitQuiz error:', error);
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ success: false, error: error.message });
  }
}

/**
 * GET /quizzes/attempts/:id/result
 * Retrieves score breakdown, student answers, and model answers (post-submit only).
 */
async function getQuizResult(req, res) {
  try {
    const attemptId = parseInteger(req.params.id);
    const userId = req.user.id;
    const userRole = req.user.role;

    if (attemptId === null || attemptId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid attempt ID' });
    }

    const attempt = await prisma.quizAttempt.findUnique({
      where: { id: attemptId },
      include: {
        quiz: true,
        user: { select: { id: true, name: true, email: true } },
      },
    });

    if (!attempt) {
      return res.status(404).json({ success: false, error: 'Attempt not found' });
    }

    if (attempt.userId !== userId && userRole !== 'ADMIN') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    if (attempt.status === STATUS.IN_PROGRESS) {
      return res.status(400).json({ success: false, error: 'Quiz attempt is still in progress' });
    }

    // Q-5: review renders the frozen start-time key (the one the attempt was
    // graded against), with live-key fallback for pre-snapshot rows.
    const answerKey = quizService.resolveAttemptKey(attempt);
    const responses = attempt.responses || {};
    const feedback = attempt.essayFeedback || {};

    // Hide-until-pass (Q-1/Q-2/Q-3): correct answers and model answers are
    // withheld from non-admins until the attempt is GRADED *and passed*.
    // EXPIRED, GRADING, and failed attempts reveal scores only — never the
    // answers (harvest-then-ace / model-leak / memorization-retake).
    // Admins always see full data (grading duty).
    const passed = (attempt.scorePercent || 0) >= (attempt.quiz.passingScore || 0);
    const showAnswers = userRole === 'ADMIN' || (attempt.status === STATUS.GRADED && passed);

    const questionsBreakdown = [];
    for (const [qName, keyEntry] of Object.entries(answerKey)) {
      const studentValue = responses[qName];
      if (keyEntry.type === 'radiogroup') {
        const isCorrect = studentValue !== undefined && String(studentValue) === String(keyEntry.correctValue);
        questionsBreakdown.push({
          name: qName,
          type: 'radiogroup',
          studentAnswer: studentValue ?? null,
          correctAnswer: showAnswers ? keyEntry.correctValue : null,
          isCorrect,
          earnedPoints: isCorrect ? keyEntry.points : 0,
          maxPoints: keyEntry.points,
        });
      } else if (keyEntry.type === 'comment') {
        const essayFb = feedback[qName] || null;
        questionsBreakdown.push({
          name: qName,
          type: 'comment',
          studentAnswer: studentValue ?? null,
          modelAnswer: showAnswers ? keyEntry.modelAnswer : null,
          earnedPoints: essayFb ? essayFb.awarded : (attempt.status === STATUS.GRADED ? 0 : null),
          maxPoints: keyEntry.points,
          feedback: essayFb ? essayFb.feedback : null,
          status: attempt.status === STATUS.GRADED ? 'GRADED' : 'PENDING_REVIEW',
          // AI attribution passthrough (transparency for students, review signal
          // for admins). Internal reasoning never leaves the AiGradingJob row.
          ...(essayFb && essayFb.gradedBy ? { gradedBy: essayFb.gradedBy } : {}),
          ...(essayFb && typeof essayFb.confidence === 'number' ? { confidence: essayFb.confidence } : {}),
          ...(essayFb && essayFb.model ? { gradedModel: essayFb.model } : {}),
        });
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        status: attempt.status,
        startedAt: attempt.startedAt,
        submittedAt: attempt.submittedAt,
        autoSubmitted: attempt.autoSubmitted,
        earnedPoints: attempt.earnedPoints,
        totalPoints: attempt.totalPoints,
        scorePercent: attempt.scorePercent,
        passed,
        passingScore: attempt.quiz.passingScore,
        questions: questionsBreakdown,
      },
    });
  } catch (error) {
    console.error('[QuizController] getQuizResult error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * GET /quizzes/videos/:videoId/attempts
 * Lists all attempts for the authenticated student for a specific video quiz.
 */
async function getStudentAttempts(req, res) {
  try {
    const { videoSlug } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const video = await resolveVideoBySlug(videoSlug);
    if (!video) {
      return res.status(404).json({ success: false, error: 'Video not found' });
    }
    const videoId = video.id;

    const quiz = await prisma.quiz.findUnique({
      where: { bunnyVideoId: videoId },
      select: {
        id: true,
        slug: true,
        title: true,
        passingScore: true,
        bunnyVideo: { select: { courseId: true } },
      },
    });

    if (!quiz) {
      return res.status(404).json({ success: false, error: 'Quiz not found' });
    }

    // Same enrollment rule as quiz meta: students see only their own courses.
    if (userRole !== 'ADMIN') {
      const enrollment = await prisma.enrollment.findFirst({
        where: { userId, courseId: quiz.bunnyVideo.courseId },
      });
      if (!enrollment) {
        return res.status(403).json({ success: false, error: 'You are not enrolled in this course' });
      }
    }

    const attempts = await prisma.quizAttempt.findMany({
      where: { userId, quizId: quiz.id },
      orderBy: { attemptNumber: 'desc' },
      select: {
        id: true,
        attemptNumber: true,
        status: true,
        startedAt: true,
        submittedAt: true,
        scorePercent: true,
        earnedPoints: true,
        totalPoints: true,
        autoSubmitted: true,
      },
    });

    return res.status(200).json({
      success: true,
      data: {
        quizSlug: quiz.slug,
        videoSlug,
        title: quiz.title,
        passingScore: quiz.passingScore,
        attempts,
      },
    });
  } catch (error) {
    console.error('[QuizController] getStudentAttempts error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Admin Endpoints ──────────────────────────────────────────────────────────

/**
 * POST /quizzes/videos/:videoId
 * Upserts a quiz definition for a video.
 * Body: { title, timeLimitSec?, passingScore?, maxAttempts?, surveyJson, answerKey }
 */
async function upsertQuiz(req, res) {
  try {
    const { videoSlug } = req.params;
    const { title, timeLimitSec, passingScore, maxAttempts, surveyJson, answerKey: rawKey } = req.body || {};

    const video = await resolveVideoBySlug(videoSlug);
    if (!video) {
      return res.status(404).json({ success: false, error: 'Video not found' });
    }
    const videoId = video.id;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ success: false, error: 'Title is required' });
    }

    // Validate SurveyJS JSON
    const surveyValidation = quizService.validateSurveyJson(surveyJson);
    if (!surveyValidation.ok) {
      return res.status(400).json({
        success: false,
        error: 'Invalid surveyJson definition',
        details: surveyValidation.errors,
      });
    }

    // Validate and build Answer Key
    if (!rawKey || typeof rawKey !== 'object' || Array.isArray(rawKey)) {
      return res.status(400).json({ success: false, error: 'answerKey object is required' });
    }

    const keyValidation = quizService.buildAnswerKey(surveyJson, rawKey);
    if (!keyValidation.ok) {
      return res.status(400).json({
        success: false,
        error: 'Invalid answerKey',
        details: keyValidation.errors,
      });
    }

    const hasTimeLimit = timeLimitSec !== undefined && timeLimitSec !== null && timeLimitSec !== '';
    const timeLimit = hasTimeLimit ? parseInteger(timeLimitSec) : null;
    if (hasTimeLimit && (timeLimit === null || timeLimit <= 0)) {
      return res.status(400).json({ success: false, error: 'timeLimitSec must be a positive integer' });
    }

const hasPassingScore = passingScore !== undefined && passingScore !== null && passingScore !== '';
    const passScore = hasPassingScore ? parseInteger(passingScore) : 50;
    if (passScore === null || passScore < 0 || passScore > 100) {
      return res.status(400).json({ success: false, error: 'passingScore must be an integer from 0 to 100' });
    }

    const hasMaxAttempts = maxAttempts !== undefined && maxAttempts !== null && maxAttempts !== '';
    const maxAttemptsValue = hasMaxAttempts ? parseInteger(maxAttempts) : 3;
    if (maxAttemptsValue === null || maxAttemptsValue < 1 || maxAttemptsValue > 10) {
      return res.status(400).json({ success: false, error: 'maxAttempts must be an integer from 1 to 10' });
    }

    const existingQuiz = await prisma.quiz.findUnique({
      where: { bunnyVideoId: videoId },
      select: { surveyJson: true },
    });

    const quiz = await prisma.quiz.upsert({
      where: { bunnyVideoId: videoId },
      create: {
        bunnyVideoId: videoId,
        title: title.trim(),
        slug: randomBase36Slug(),
        timeLimitSec: timeLimit,
        passingScore: passScore,
        maxAttempts: maxAttemptsValue,
        surveyJson,
        answerKey: keyValidation.answerKey,
      },
      update: {
        title: title.trim(),
        timeLimitSec: timeLimit,
        passingScore: passScore,
        maxAttempts: maxAttemptsValue,
        surveyJson,
        answerKey: keyValidation.answerKey,
      },
    });

    // Replaced images orphan in the bucket — diff old vs new surveyJson object
    // lists and remove the drop-outs (best-effort, never fails the save).
    try {
      const { extractBucketObjectNames, getSupabaseAdmin, getSupabaseBucket } = require('../integrations/supabase/supabaseClient');
      const oldNames = existingQuiz ? extractBucketObjectNames(existingQuiz.surveyJson) : [];
      const newNames = new Set(extractBucketObjectNames(surveyJson));
      const onlyOld = oldNames.filter((name) => !newNames.has(name));
      if (onlyOld.length > 0) {
        const { error } = await getSupabaseAdmin()
          .storage.from(getSupabaseBucket())
          .remove(onlyOld);
        if (error) console.error('[QuizController] upsert image cleanup error:', error.message);
      }
    } catch (cleanupErr) {
      console.error('[QuizController] upsert image cleanup failed:', cleanupErr.message);
    }

    // Quiz presence is cached on the videos list — invalidate it (best-effort).
    try {
      const { invalidateVideoCaches } = require('../services/bunnyVideoService');
      const video = await prisma.bunnyVideo.findUnique({
        where: { id: quiz.bunnyVideoId },
        select: { courseId: true },
      });
      if (video) await invalidateVideoCaches(video.courseId);
    } catch {
      // Stale cache self-heals in 60s; never fail the save for it.
    }

    // Quiz definition changed (title/passingScore/questions feed cached meta
    // for every user) — drop the namespace (rare admin op, bounded scan).
    await cache.delPrefix('v1:quiz:meta:');

    await audit.record(req, {
      action: existingQuiz ? 'QUIZ_UPDATE' : 'QUIZ_CREATE',
      targetType: 'quiz',
      targetId: quiz.id,
      metadata: { videoSlug, title: title.trim() },
    });

    return res.status(200).json({
      success: true,
      message: 'Quiz saved successfully',
      data: quizService.sanitizeForStudent(quiz),
    });
  } catch (error) {
    console.error('[QuizController] upsertQuiz error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * DELETE /quizzes/:quizId
 * Deletes a quiz and all associated attempts.
 */
async function deleteQuiz(req, res) {
  try {
    const { quizSlug } = req.params;
    if (!isValidSlug(quizSlug)) {
      return res.status(400).json({ success: false, error: 'Invalid quiz slug' });
    }

    const quiz = await prisma.quiz.findUnique({ where: { slug: quizSlug } });
    if (!quiz) {
      return res.status(404).json({ success: false, error: 'Quiz not found' });
    }
    const quizId = quiz.id;

    await prisma.quiz.delete({ where: { id: quizId } });

    // Quiz rows cascade-delete — remove this quiz's SurveyJS images from
    // Supabase Storage so the bucket doesn't accumulate orphans (best-effort:
    // a storage failure must never fail an already-succeeded DB delete).
    try {
      const { removeQuizImagesBestEffort } = require('../integrations/supabase/supabaseClient');
      await removeQuizImagesBestEffort(quiz.surveyJson);
    } catch (cleanupErr) {
      console.error('[QuizController] deleteQuiz storage cleanup error:', cleanupErr.message);
    }

    // Quiz presence is cached on the videos list — invalidate it (best-effort).
    try {
      const { invalidateVideoCaches } = require('../services/bunnyVideoService');
      const video = await prisma.bunnyVideo.findUnique({
        where: { id: quiz.bunnyVideoId },
        select: { courseId: true },
      });
      if (video) await invalidateVideoCaches(video.courseId);
      await cache.delPrefix('v1:quiz:meta:');
    } catch {
      // Stale cache self-heals in 60s; never fail the delete for it.
    }

    await audit.record(req, {
      action: 'QUIZ_DELETE',
      targetType: 'quiz',
      targetId: quizId,
      metadata: { videoId: quiz.bunnyVideoId, title: quiz.title },
    });

    return res.status(200).json({ success: true, message: 'Quiz deleted successfully' });
  } catch (error) {
    console.error('[QuizController] deleteQuiz error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * GET /quizzes/:quizId/attempts
 * Lists student attempts for a quiz (filter by ?status=GRADING for grading queue).
 */
async function listQuizAttempts(req, res) {
  try {
    const { quizSlug } = req.params;
    const { status } = req.query;

    if (!isValidSlug(quizSlug)) {
      return res.status(400).json({ success: false, error: 'Invalid quiz slug' });
    }

    const quiz = await prisma.quiz.findUnique({
      where: { slug: quizSlug },
      select: { id: true },
    });
    if (!quiz) {
      return res.status(404).json({ success: false, error: 'Quiz not found' });
    }
    const quizId = quiz.id;

    const where = { quizId };
    if (status) {
      if (!Object.values(STATUS).includes(status)) {
        return res.status(400).json({ success: false, error: 'Invalid attempt status filter' });
      }
      where.status = status;
    }

    // Z-1: explicit select — never leak per-question `responses` in the list
    // view (grading UI opens one attempt via the result endpoint for answers).
    const attempts = await prisma.quizAttempt.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        quizId: true,
        userId: true,
        attemptNumber: true,
        status: true,
        startedAt: true,
        deadlineAt: true,
        submittedAt: true,
        autoSubmitted: true,
        mcqEarned: true,
        essayEarned: true,
        earnedPoints: true,
        totalPoints: true,
        scorePercent: true,
        essayFeedback: true,
        essayGradedBy: true,
        essayGradedAt: true,
        user: { select: { id: true, name: true, email: true } },
      },
    });

    return res.status(200).json({ success: true, data: attempts });
  } catch (error) {
    console.error('[QuizController] listQuizAttempts error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * GET /admin/quizzes
 * Admin console: paginated quiz index with video + course context and attempt counts.
 * ?page= &limit= &search= (quiz title / video title / course title)
 * Never leaks answerKey.
 */
async function listAllQuizzes(req, res) {
  try {
    const page = Math.max(parseInteger(req.query.page) || 1, 1);
    const take = Math.max(1, Math.min(parseInteger(req.query.limit) || 20, 100));
    const skip = (page - 1) * take;
    const search = (req.query.search || '').trim();

    const where = {};
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { bunnyVideo: { title: { contains: search, mode: 'insensitive' } } },
        { bunnyVideo: { course: { title: { contains: search, mode: 'insensitive' } } } },
      ];
    }

    const [quizzes, total] = await Promise.all([
      prisma.quiz.findMany({
        skip,
        take,
        where,
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          slug: true,
          title: true,
          timeLimitSec: true,
          passingScore: true,
          maxAttempts: true,
          updatedAt: true,
          bunnyVideo: { select: { id: true, slug: true, title: true, course: { select: { id: true, slug: true, title: true } } } },
          _count: { select: { attempts: true } },
        },
      }),
      prisma.quiz.count({ where }),
    ]);

    const gradingCounts = await prisma.quizAttempt.groupBy({
      by: ['quizId'],
      where: { status: STATUS.GRADING },
      _count: { _all: true },
    });
    const gradingMap = new Map(gradingCounts.map((g) => [g.quizId, g._count._all]));

    const data = quizzes.map((q) => ({
      slug: q.slug,
      title: q.title,
      videoSlug: q.bunnyVideo.slug,
      videoTitle: q.bunnyVideo.title,
      courseSlug: q.bunnyVideo.course.slug,
      courseTitle: q.bunnyVideo.course.title,
      timeLimitSec: q.timeLimitSec,
      passingScore: q.passingScore,
      maxAttempts: q.maxAttempts,
      totalAttempts: q._count.attempts,
      pendingGrading: gradingMap.get(q.id) || 0,
      updatedAt: q.updatedAt,
    }));

    return res.json({
      success: true,
      data,
      meta: { total, page, limit: take, totalPages: Math.ceil(total / take) },
    });
  } catch (error) {
    console.error('[QuizController] listAllQuizzes error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * GET /admin/attempts
 * Admin console: global attempt list (all quizzes) with student + quiz context.
 * ?status= &page= &limit= &search= (student name/email / quiz title)
 * Excludes responses for privacy in list view (detail available via result endpoint).
 */
async function listAllAttempts(req, res) {
  try {
    const { status } = req.query;
    if (status && !Object.values(STATUS).includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid attempt status filter' });
    }

    const page = Math.max(parseInteger(req.query.page) || 1, 1);
    const take = Math.max(1, Math.min(parseInteger(req.query.limit) || 20, 100));
    const skip = (page - 1) * take;
    const search = (req.query.search || '').trim();

    const where = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { user: { name: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { quiz: { title: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [attempts, total] = await Promise.all([
      prisma.quizAttempt.findMany({
        skip,
        take,
        where,
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          quizId: true,
          attemptNumber: true,
          status: true,
          startedAt: true,
          submittedAt: true,
          mcqEarned: true,
          essayEarned: true,
          scorePercent: true,
          essayGradedAt: true,
          user: { select: { id: true, name: true, email: true, grade: true } },
          quiz: {
            select: {
              id: true,
              title: true,
              passingScore: true,
              maxAttempts: true,
              bunnyVideo: { select: { id: true, title: true, course: { select: { id: true, title: true } } } },
            },
          },
        },
      }),
      prisma.quizAttempt.count({ where }),
    ]);

    const data = attempts.map((a) => ({
      id: a.id,
      quizId: a.quizId,
      quizTitle: a.quiz.title,
      videoId: a.quiz.bunnyVideo.id,
      videoTitle: a.quiz.bunnyVideo.title,
      courseId: a.quiz.bunnyVideo.course.id,
      courseTitle: a.quiz.bunnyVideo.course.title,
      student: a.user,
      attemptNumber: a.attemptNumber,
      status: a.status,
      startedAt: a.startedAt,
      submittedAt: a.submittedAt,
      mcqEarned: a.mcqEarned,
      essayEarned: a.essayEarned,
      scorePercent: a.scorePercent,
      passingScore: a.quiz.passingScore,
      passed: a.scorePercent !== null ? a.scorePercent >= a.quiz.passingScore : null,
      essayGradedAt: a.essayGradedAt,
    }));

    return res.json({
      success: true,
      data,
      meta: { total, page, limit: take, totalPages: Math.ceil(total / take) },
    });
  } catch (error) {
    console.error('[QuizController] listAllAttempts error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * PUT /quizzes/attempts/:id/grade
 * Admin grades essay questions and finalizes attempt score.
 * Body: { essayScores: { [qName]: number }, essayFeedback?: { [qName]: string } }
 */
async function gradeAttempt(req, res) {
  try {
    const attemptId = parseInteger(req.params.id);
    const adminId = req.user.id;
    const { essayScores, essayFeedback } = req.body;

    if (attemptId === null || attemptId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid attempt ID' });
    }

    if (!essayScores || typeof essayScores !== 'object' || Array.isArray(essayScores)) {
      return res.status(400).json({ success: false, error: 'essayScores object is required' });
    }

    if (essayFeedback !== undefined && (essayFeedback === null || typeof essayFeedback !== 'object' || Array.isArray(essayFeedback))) {
      return res.status(400).json({ success: false, error: 'essayFeedback must be an object' });
    }

    const updated = await quizService.gradeEssayAttempt(adminId, attemptId, essayScores, essayFeedback || {});

    return res.status(200).json({
      success: true,
      message: 'Attempt graded successfully',
      data: updated,
    });
  } catch (error) {
    console.error('[QuizController] gradeAttempt error:', error);
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ success: false, error: error.message });
  }
}

/**
 * POST /quizzes/attempts/:id/reset
 * Deletes a student attempt to allow a manual reset.
 */
async function resetAttempt(req, res) {
  try {
    const attemptId = parseInteger(req.params.id);
    if (attemptId === null || attemptId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid attempt ID' });
    }

    const attempt = await prisma.quizAttempt.findUnique({
      where: { id: attemptId },
      select: { userId: true, quiz: { select: { bunnyVideoId: true } } },
    });
    if (!attempt) {
      return res.status(404).json({ success: false, error: 'Attempt not found' });
    }

    await prisma.quizAttempt.delete({ where: { id: attemptId } });

    // Invalidate AFTER delete (never before — a concurrent read in between
    // would re-cache pre-delete state). Ids come from the pre-delete lookup
    // above since the helper's own row lookup would miss post-delete.
    // (Helpers never throw by contract — safe to await inline.)
    if (attempt.quiz) await quizService.invalidateQuizMeta(attempt.userId, attempt.quiz.bunnyVideoId);
    // Reset removes a GRADED score that may gate the next video.
    await quizService.invalidateGateForUser(attempt.userId);

    return res.status(200).json({ success: true, message: 'Attempt reset successfully' });
  } catch (error) {
    console.error('[QuizController] resetAttempt error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * POST /quizzes/videos/:videoId/exemptions
 * Grants a gate exemption to a student for a specific video quiz.
 * Body: { userId, reason? }
 */
async function grantExemption(req, res) {
  try {
    const { videoSlug } = req.params;
    const adminId = req.user.id;
    const { userSlug, reason } = req.body;

    if (!isValidSlug(videoSlug) || !isValidSlug(userSlug)) {
      return res.status(400).json({ success: false, error: 'videoSlug and userSlug are required' });
    }

    // Validate FK targets up front: a missing user or video must be a 404,
    // never a P2003 foreign-key 500 from the upsert below.
    const [video, student] = await Promise.all([
      prisma.bunnyVideo.findUnique({ where: { slug: videoSlug }, select: { id: true } }),
      prisma.user.findUnique({ where: { slug: userSlug }, select: { id: true } }),
    ]);
    if (!video) {
      return res.status(404).json({ success: false, error: 'Video not found' });
    }
    if (!student) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const videoId = video.id;
    const studentId = student.id;

    let exemption;
    try {
      exemption = await prisma.gateExemption.upsert({
        where: { userId_bunnyVideoId: { userId: studentId, bunnyVideoId: videoId } },
        create: {
          userId: studentId,
          bunnyVideoId: videoId,
          grantedBy: adminId,
          reason: reason || null,
        },
        update: {
          grantedBy: adminId,
          reason: reason || null,
        },
      });
    } catch (upsertError) {
      // Narrow race (user/video deleted between check and write) → 404, not 500.
      if (upsertError.code === 'P2003') {
        return res.status(404).json({ success: false, error: 'User or video not found' });
      }
      throw upsertError;
    }

    // Exemptions affect gates enforced at playback/complete time; meta itself
    // carries no gate verdict today — invalidate defensively so future
    // gate-derived fields can never go stale.
    await quizService.invalidateQuizMetaForUser(studentId);
    // Gate cache depends on exemptions — invalidate so the new exemption
    // is reflected immediately in the sequential gate.
    await quizService.invalidateGateForUser(studentId);

    await audit.record(req, {
      action: 'GATE_EXEMPTION_GRANT',
      targetType: 'gateExemption',
      targetId: exemption.id,
      metadata: { userId: studentId, videoId, reason: reason || null },
    });

    return res.status(200).json({
      success: true,
      message: 'Gate exemption granted successfully',
      data: exemption,
    });
  } catch (error) {
    console.error('[QuizController] grantExemption error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

/**
 * DELETE /quizzes/exemptions/:exemptionId
 * Revokes a gate exemption.
 */
async function revokeExemption(req, res) {
  try {
    const exemptionId = parseInteger(req.params.exemptionId);
    if (exemptionId === null || exemptionId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid exemption ID' });
    }

    try {
      const doomed = await prisma.gateExemption.findUnique({
        where: { id: exemptionId },
        select: { userId: true },
      });
      await prisma.gateExemption.delete({ where: { id: exemptionId } });
      if (doomed) await quizService.invalidateQuizMetaForUser(doomed.userId);
      if (doomed) await quizService.invalidateGateForUser(doomed.userId);
    } catch (error) {
      if (error.code === 'P2025') {
        return res.status(404).json({ success: false, error: 'Exemption not found' });
      }
      throw error;
    }

    await audit.record(req, {
      action: 'GATE_EXEMPTION_REVOKE',
      targetType: 'gateExemption',
      targetId: exemptionId,
    });

    return res.status(200).json({ success: true, message: 'Exemption revoked successfully' });
  } catch (error) {
    console.error('[QuizController] revokeExemption error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Admin: quiz question image upload (Supabase Storage) ───────────────────

const QUIZ_IMAGE_MIME_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const QUIZ_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5MB — bounded in-memory buffer (storage-js has no streaming API)

/**
 * POST /quizzes/images
 * Admin-only. Accepts a single image (multipart field "image"), forwards it to
 * the Supabase Storage bucket, and returns the public URL for question `imageLink`.
 * Busboy streaming is handled inside the controller — no body-parser middleware here.
 */
async function uploadQuizImage(req, res) {
  const { isSupabaseConfigured, getSupabaseAdmin, getSupabaseBucket } = require('../integrations/supabase/supabaseClient');
  if (!isSupabaseConfigured()) {
    return res.status(501).json({ success: false, error: 'Image upload is not configured' });
  }

  let bb;
  try {
    bb = busboy({ headers: req.headers, limits: { fileSize: QUIZ_IMAGE_MAX_BYTES, files: 1 } });
  } catch {
    return res.status(400).json({ success: false, error: 'Invalid multipart request' });
  }

  let fileHandled = false;
  let failure = null; // 'IMAGE_TOO_LARGE' | 'INVALID_IMAGE_TYPE' | 'IMAGE_READ_FAILED' | 'IMAGE_UPLOAD_FAILED'
  let uploadInFlight = false;
  let responded = false;
  const respond = (status, body) => {
    if (responded) return undefined;
    responded = true;
    return res.status(status).json(body);
  };
  const respondFailure = () => {
    if (failure === 'IMAGE_TOO_LARGE') return respond(413, { success: false, error: 'Image too large (max 5MB)' });
    if (failure === 'INVALID_IMAGE_TYPE') return respond(415, { success: false, error: 'Only JPEG, PNG, WebP or GIF images are allowed' });
    if (failure === 'IMAGE_UPLOAD_FAILED') return respond(502, { success: false, error: 'Image upload failed' });
    return respond(500, { success: false, error: 'Image upload failed' });
  };

  // NOTE: never call bb.destroy(err) from inside a file handler — busboy
  // propagates the error to the part stream, which crashes the process with
  // an unhandled 'error' event. Drain + answer on 'finish' instead.
  bb.on('file', (fieldName, fileStream, info) => {
    fileStream.on('error', () => { failure = failure || 'IMAGE_READ_FAILED'; });
    if (failure) { fileStream.resume(); return; }
    if (fieldName !== 'image') {
      fileStream.resume();
      return;
    }
    const ext = QUIZ_IMAGE_MIME_TYPES[(info.mimeType || '').toLowerCase()];
    if (!ext) {
      failure = 'INVALID_IMAGE_TYPE';
      fileStream.resume();
      return;
    }
    fileHandled = true;
    const chunks = [];
    let size = 0;
    fileStream.on('data', (chunk) => {
      if (failure) return;
      size += chunk.length;
      if (size > QUIZ_IMAGE_MAX_BYTES) {
        failure = 'IMAGE_TOO_LARGE';
        fileStream.resume();
        return;
      }
      chunks.push(chunk);
    });
    fileStream.on('limit', () => {
      failure = failure || 'IMAGE_TOO_LARGE';
      fileStream.resume();
    });
    fileStream.on('end', async () => {
      if (failure || responded) return;
      uploadInFlight = true;
      try {
        const buffer = Buffer.concat(chunks);
        const filename = `${crypto.randomUUID()}${ext}`;
        const sb = getSupabaseAdmin();
        // Bounded wait: a hung storage call must fail the request (502), not
        // pin the handler. Images are ≤5MB — 30s is generous.
        const upload = sb.storage
          .from(getSupabaseBucket())
          .upload(filename, buffer, { contentType: info.mimeType, upsert: false });
        const { error } = await Promise.race([
          upload,
          new Promise((_, reject) => setTimeout(() => reject(new Error('storage timeout')), 30000)),
        ]);
        if (error) throw new Error(error.message);
        const { data } = sb.storage.from(getSupabaseBucket()).getPublicUrl(filename);
        respond(201, { success: true, data: { url: data.publicUrl } });
      } catch (error) {
        console.error('[QuizController] uploadQuizImage failed:', error.message);
        failure = 'IMAGE_UPLOAD_FAILED';
        respondFailure();
      } finally {
        uploadInFlight = false;
      }
    });
  });

  bb.on('error', () => {
    failure = failure || 'IMAGE_READ_FAILED';
  });

  bb.on('finish', () => {
    if (responded || uploadInFlight) return;
    if (failure) return respondFailure();
    if (!fileHandled) {
      return respond(400, { success: false, error: 'No "image" file field found in the request' });
    }
  });

  req.pipe(bb);
}

module.exports = {
  getQuizMeta,
  startQuiz,
  saveQuizAttempt,
  submitQuiz,
  getQuizResult,
  getStudentAttempts,
  upsertQuiz,
  deleteQuiz,
  uploadQuizImage,
  listQuizAttempts,
  listAllQuizzes,
  listAllAttempts,
  gradeAttempt,
  resetAttempt,
  grantExemption,
  revokeExemption,
};
