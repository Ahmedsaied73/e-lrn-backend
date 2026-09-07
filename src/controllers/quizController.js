'use strict';

/**
 * quizController.js
 * Thin HTTP adapters for Quiz endpoints.
 * Handles request parsing, authentication context, calls quizService, and formats responses.
 */

const prisma = require('../config/db');
const quizService = require('../services/quizService');
const { STATUS } = require('../config/quizConfig');

function parseInteger(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

// ─── Student Endpoints ────────────────────────────────────────────────────────

/**
 * GET /quizzes/videos/:videoId/meta
 * Returns metadata driving the "بدء الاختبار" button:
 * exists, unlocked (video completed), attempted, passed, bestScore, timeLimitSec, inProgressAttempt
 */
async function getQuizMeta(req, res) {
  try {
    const videoId = parseInteger(req.params.videoId);
    const userId = req.user.id;
    const userRole = req.user.role;

    if (videoId === null || videoId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid video ID' });
    }

    const video = await prisma.bunnyVideo.findUnique({
      where: { id: videoId },
      include: {
        quiz: true,
        course: { select: { id: true } },
      },
    });

    if (!video) {
      return res.status(404).json({ success: false, error: 'Video not found' });
    }

    // Check enrollment if student
    if (userRole !== 'ADMIN') {
      const enrollment = await prisma.enrollment.findFirst({
        where: { userId, courseId: video.courseId },
      });
      if (!enrollment) {
        return res.status(403).json({ success: false, error: 'You are not enrolled in this course' });
      }
    }

    if (!video.quiz) {
      return res.status(200).json({
        success: true,
        data: {
          exists: false,
          videoId,
          videoTitle: video.title,
        },
      });
    }

    const quiz = video.quiz;

    // Check if video is completed (unlock signal for quiz)
    let videoCompleted = true;
    if (userRole !== 'ADMIN') {
      const progress = await prisma.bunnyVideoProgress.findFirst({
        where: { userId, bunnyVideoId: videoId, completed: true },
      });
      videoCompleted = !!progress;
    }

    // Get all user attempts for this quiz
    const attempts = await prisma.quizAttempt.findMany({
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
    });

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

    return res.status(200).json({
      success: true,
      data: {
        exists: true,
        quizId: quiz.id,
        videoId,
        videoTitle: video.title,
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
      },
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
    const videoId = parseInteger(req.params.videoId);
    const userId = req.user.id;
    const userRole = req.user.role;

    if (videoId === null || videoId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid video ID' });
    }

    const video = await prisma.bunnyVideo.findUnique({
      where: { id: videoId },
      include: { quiz: true },
    });

    if (!video || !video.quiz) {
      return res.status(404).json({ success: false, error: 'No quiz found for this video' });
    }

    // Check enrollment and video completion for students
    if (userRole !== 'ADMIN') {
      const enrollment = await prisma.enrollment.findFirst({
        where: { userId, courseId: video.courseId },
      });
      if (!enrollment) {
        return res.status(403).json({ success: false, error: 'You are not enrolled in this course' });
      }

      const progress = await prisma.bunnyVideoProgress.findFirst({
        where: { userId, bunnyVideoId: videoId, completed: true },
      });
      if (!progress) {
        return res.status(403).json({ success: false, error: 'You must complete the video before taking the quiz' });
      }
    }

const { attempt, quiz, resumed } = await quizService.startAttempt(userId, video.quiz.id, {
      bypassPassedCheck: userRole === 'ADMIN',
    });
    const safeQuiz = quizService.sanitizeForStudent(quiz);

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

    const answerKey = attempt.quiz.answerKey || {};
    const responses = attempt.responses || {};
    const feedback = attempt.essayFeedback || {};

    const questionsBreakdown = [];
    for (const [qName, keyEntry] of Object.entries(answerKey)) {
      const studentValue = responses[qName];
      if (keyEntry.type === 'radiogroup') {
        const isCorrect = studentValue !== undefined && String(studentValue) === String(keyEntry.correctValue);
        questionsBreakdown.push({
          name: qName,
          type: 'radiogroup',
          studentAnswer: studentValue ?? null,
          correctAnswer: keyEntry.correctValue,
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
          modelAnswer: keyEntry.modelAnswer,
          earnedPoints: essayFb ? essayFb.awarded : (attempt.status === STATUS.GRADED ? 0 : null),
          maxPoints: keyEntry.points,
          feedback: essayFb ? essayFb.feedback : null,
          status: attempt.status === STATUS.GRADED ? 'GRADED' : 'PENDING_REVIEW',
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
        passed: (attempt.scorePercent || 0) >= attempt.quiz.passingScore,
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
    const videoId = parseInteger(req.params.videoId);
    const userId = req.user.id;

    if (videoId === null || videoId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid video ID' });
    }

    const quiz = await prisma.quiz.findUnique({
      where: { bunnyVideoId: videoId },
      select: { id: true, title: true, passingScore: true },
    });

    if (!quiz) {
      return res.status(404).json({ success: false, error: 'Quiz not found' });
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
        quizId: quiz.id,
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
    const videoId = parseInteger(req.params.videoId);
    const { title, timeLimitSec, passingScore, maxAttempts, surveyJson, answerKey: rawKey } = req.body || {};

    if (videoId === null || videoId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid video ID' });
    }

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ success: false, error: 'Title is required' });
    }

    const video = await prisma.bunnyVideo.findUnique({ where: { id: videoId } });
    if (!video) {
      return res.status(404).json({ success: false, error: 'Video not found' });
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

    const quiz = await prisma.quiz.upsert({
      where: { bunnyVideoId: videoId },
      create: {
        bunnyVideoId: videoId,
        title: title.trim(),
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
    const quizId = parseInteger(req.params.quizId);
    if (quizId === null || quizId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid quiz ID' });
    }

    const quiz = await prisma.quiz.findUnique({ where: { id: quizId } });
    if (!quiz) {
      return res.status(404).json({ success: false, error: 'Quiz not found' });
    }

    await prisma.quiz.delete({ where: { id: quizId } });

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
    const quizId = parseInteger(req.params.quizId);
    const { status } = req.query;

    if (quizId === null || quizId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid quiz ID' });
    }

    const where = { quizId };
    if (status) {
      if (!Object.values(STATUS).includes(status)) {
        return res.status(400).json({ success: false, error: 'Invalid attempt status filter' });
      }
      where.status = status;
    }

    const attempts = await prisma.quizAttempt.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      include: {
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
        { title: { contains: search } },
        { bunnyVideo: { title: { contains: search } } },
        { bunnyVideo: { course: { title: { contains: search } } } },
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
          title: true,
          timeLimitSec: true,
          passingScore: true,
          maxAttempts: true,
          updatedAt: true,
          bunnyVideoId: true,
          bunnyVideo: { select: { id: true, title: true, course: { select: { id: true, title: true } } } },
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
      id: q.id,
      title: q.title,
      videoId: q.bunnyVideoId,
      videoTitle: q.bunnyVideo.title,
      courseId: q.bunnyVideo.course.id,
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
        { user: { name: { contains: search } } },
        { user: { email: { contains: search } } },
        { quiz: { title: { contains: search } } },
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

    const attempt = await prisma.quizAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt) {
      return res.status(404).json({ success: false, error: 'Attempt not found' });
    }

    await prisma.quizAttempt.delete({ where: { id: attemptId } });

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
    const videoId = parseInteger(req.params.videoId);
    const adminId = req.user.id;
    const { userId, reason } = req.body;

    const parsedUserId = parseInteger(userId);
    if (videoId === null || videoId <= 0 || parsedUserId === null || parsedUserId <= 0) {
      return res.status(400).json({ success: false, error: 'videoId and userId are required' });
    }

    const exemption = await prisma.gateExemption.upsert({
      where: { userId_bunnyVideoId: { userId: parsedUserId, bunnyVideoId: videoId } },
      create: {
        userId: parsedUserId,
        bunnyVideoId: videoId,
        grantedBy: adminId,
        reason: reason || null,
      },
      update: {
        grantedBy: adminId,
        reason: reason || null,
      },
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
      await prisma.gateExemption.delete({ where: { id: exemptionId } });
    } catch (error) {
      if (error.code === 'P2025') {
        return res.status(404).json({ success: false, error: 'Exemption not found' });
      }
      throw error;
    }

    return res.status(200).json({ success: true, message: 'Exemption revoked successfully' });
  } catch (error) {
    console.error('[QuizController] revokeExemption error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
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
  listQuizAttempts,
  listAllQuizzes,
  listAllAttempts,
  gradeAttempt,
  resetAttempt,
  grantExemption,
  revokeExemption,
};
