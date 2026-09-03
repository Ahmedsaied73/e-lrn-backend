'use strict';

/**
 * quizService.js
 * ALL quiz business logic lives here — framework-free and reusable.
 * Controllers are thin HTTP adapters that call these functions.
 *
 * Dependencies: prisma client, quizConfig, bunnyStreamClient (for image upload)
 */

const prisma = require('../config/db');
const { ALLOWED_QUESTION_TYPES, MAX_SURVEY_JSON_BYTES, GRACE_SEC, STATUS } = require('../config/quizConfig');
const bunny = require('../integrations/bunny/bunnyStreamClient');

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a SurveyJS JSON definition submitted by an admin.
 * Checks byte size, pages presence, element names uniqueness, and whitelisted types.
 *
 * @param {object} surveyJson - Parsed SurveyJS JSON object
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateSurveyJson(surveyJson) {
  const errors = [];

  // Size check
  const raw = JSON.stringify(surveyJson);
  if (Buffer.byteLength(raw, 'utf8') > MAX_SURVEY_JSON_BYTES) {
    errors.push(`surveyJson exceeds maximum size of ${MAX_SURVEY_JSON_BYTES / 1024} KB`);
  }

  // Pages required
  if (!surveyJson || !Array.isArray(surveyJson.pages) || surveyJson.pages.length === 0) {
    errors.push('surveyJson must have at least one page with elements');
    return { ok: false, errors };
  }

  const names = new Set();
  for (const page of surveyJson.pages) {
    if (!Array.isArray(page.elements)) continue;
    for (const el of page.elements) {
      // Type whitelist
      if (!ALLOWED_QUESTION_TYPES.includes(el.type)) {
        errors.push(`Question type "${el.type}" is not allowed. Allowed types: ${ALLOWED_QUESTION_TYPES.join(', ')}`);
      }
      // Unique names
      if (!el.name) {
        errors.push('Every question element must have a "name" property');
      } else if (names.has(el.name)) {
        errors.push(`Duplicate question name: "${el.name}"`);
      } else {
        names.add(el.name);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Build and validate the server-side answer key from admin input.
 * Ensures every scorable question in surveyJson has a corresponding key entry.
 *
 * answerKeyInput shape: {
 *   [qName]: {
 *     type: 'radiogroup' | 'comment',
 *     correctValue: string,   // MCQ only — the value of the correct choice
 *     modelAnswer: string,    // Essay — reference answer shown after grading
 *     points: number          // Max points for this question (must be > 0)
 *   }
 * }
 *
 * @param {object} surveyJson
 * @param {object} answerKeyInput
 * @returns {{ ok: boolean, errors: string[], answerKey: object }}
 */
function buildAnswerKey(surveyJson, answerKeyInput) {
  const errors = [];
  const answerKey = {};
  const questionNames = new Set();

  for (const page of surveyJson.pages) {
    if (!Array.isArray(page.elements)) continue;
    for (const el of page.elements) {
      if (el.type === 'html' || el.type === 'image') continue; // non-scorable
      questionNames.add(el.name);
    }
  }

  for (const name of questionNames) {
    const entry = answerKeyInput[name];
    if (!entry) {
      errors.push(`Missing answer key entry for question "${name}"`);
      continue;
    }
    if (typeof entry.points !== 'number' || entry.points <= 0) {
      errors.push(`Question "${name}": points must be a positive number`);
    }
    if (entry.type === 'radiogroup') {
      if (entry.correctValue === undefined || entry.correctValue === null || entry.correctValue === '') {
        errors.push(`MCQ question "${name}": correctValue is required`);
      }
    } else if (entry.type === 'comment') {
      if (!entry.modelAnswer) {
        errors.push(`Essay question "${name}": modelAnswer is required`);
      }
    } else {
      errors.push(`Answer key entry for "${name}" has unknown type "${entry.type}"`);
    }
    answerKey[name] = {
      type: entry.type,
      correctValue: entry.correctValue ?? null,
      modelAnswer: entry.modelAnswer ?? null,
      points: entry.points,
    };
  }

  return { ok: errors.length === 0, errors, answerKey };
}

/**
 * Strip the answerKey from a quiz record before sending to a student.
 * Returns only the fields safe for the client.
 *
 * @param {object} quiz - Raw Prisma quiz row
 * @returns {object} Student-safe quiz object
 */
function sanitizeForStudent(quiz) {
  return {
    id: quiz.id,
    videoId: quiz.videoId,
    title: quiz.title,
    timeLimitSec: quiz.timeLimitSec,
    passingScore: quiz.passingScore,
    surveyJson: quiz.surveyJson,
    // answerKey intentionally excluded
  };
}

// ─── Grading ─────────────────────────────────────────────────────────────────

/**
 * Auto-grade MCQ responses against the answer key.
 *
 * @param {object} answerKey - Server-side answer key
 * @param {object} responses - Student responses { [qName]: value }
 * @returns {{ mcqEarned: number, totalMcqPoints: number, perQuestion: Array }}
 */
function gradeMcq(answerKey, responses) {
  let mcqEarned = 0;
  let totalMcqPoints = 0;
  const perQuestion = [];

  for (const [qName, keyEntry] of Object.entries(answerKey)) {
    if (keyEntry.type !== 'radiogroup') continue;
    totalMcqPoints += keyEntry.points;
    const studentValue = responses[qName];
    const isCorrect = studentValue !== undefined && String(studentValue) === String(keyEntry.correctValue);
    if (isCorrect) mcqEarned += keyEntry.points;
    perQuestion.push({ qName, isCorrect, earned: isCorrect ? keyEntry.points : 0, max: keyEntry.points });
  }

  return { mcqEarned, totalMcqPoints, perQuestion };
}

/**
 * Compute total point tallies for all question types.
 *
 * @param {object} answerKey
 * @returns {{ totalPoints: number, totalMcqPoints: number, totalEssayPoints: number }}
 */
function computeTotalPoints(answerKey) {
  let totalPoints = 0;
  let totalMcqPoints = 0;
  let totalEssayPoints = 0;
  for (const entry of Object.values(answerKey)) {
    totalPoints += entry.points;
    if (entry.type === 'radiogroup') totalMcqPoints += entry.points;
    else if (entry.type === 'comment') totalEssayPoints += entry.points;
  }
  return { totalPoints, totalMcqPoints, totalEssayPoints };
}

/**
 * Compute final scorePercent from earned points.
 * Returns 0 if totalPoints is 0 to avoid division by zero.
 *
 * @param {number} earnedPoints
 * @param {number} totalPoints
 * @returns {number} Percentage 0–100
 */
function computeScorePercent(earnedPoints, totalPoints) {
  if (!totalPoints || totalPoints === 0) return 0;
  return parseFloat(((earnedPoints / totalPoints) * 100).toFixed(2));
}

// ─── Gate Evaluation ─────────────────────────────────────────────────────────

/**
 * Single source of truth for sequential video access gate.
 * Checks whether userId is allowed to access videoId based on:
 *   1. Admin role → always allowed
 *   2. GateExemption for (userId, previousVideoId) → allowed
 *   3. VideoProgress(previousVideo).completed = true
 *      AND (no quiz on previousVideo OR best attempt scorePercent >= passingScore)
 *
 * @param {number} userId
 * @param {number} videoId  - The video being accessed
 * @param {string} userRole - User role (ADMIN bypasses all checks)
 * @returns {Promise<{ allowed: boolean, reason?: string, quizId?: number, bestScore?: number, required?: number }>}
 */
async function evaluateGate(userId, videoId, userRole) {
  // Admins bypass everything
  if (userRole === 'ADMIN') return { allowed: true };

  // Get the requested video and its course
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    include: { course: { select: { id: true } } },
  });
  if (!video) return { allowed: false, reason: 'Video not found' };

  // Get all videos in course ordered by position then id
  const courseVideos = await prisma.video.findMany({
    where: { courseId: video.courseId },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });

  const currentIndex = courseVideos.findIndex(v => v.id === videoId);
  if (currentIndex <= 0) return { allowed: true }; // First video always accessible

  const previousVideoId = courseVideos[currentIndex - 1].id;

  // Check GateExemption for previous video
  const exemption = await prisma.gateExemption.findUnique({
    where: { userId_videoId: { userId, videoId: previousVideoId } },
  });
  if (exemption) return { allowed: true };

  // Check previous video completion
  const progress = await prisma.videoProgress.findFirst({
    where: { userId, videoId: previousVideoId, completed: true },
  });
  if (!progress) {
    return {
      allowed: false,
      reason: 'You must complete the previous video before accessing this one',
      previousVideoId,
    };
  }

  // Check if previous video has a quiz
  const quiz = await prisma.quiz.findUnique({
    where: { videoId: previousVideoId },
    select: { id: true, passingScore: true },
  });

  // No quiz on previous video → gate passed
  if (!quiz) return { allowed: true };

  // Find best completed attempt score
  const bestAttempt = await prisma.quizAttempt.findFirst({
    where: {
      userId,
      quizId: quiz.id,
      status: { in: ['GRADED'] },
    },
    orderBy: { scorePercent: 'desc' },
    select: { scorePercent: true },
  });

  if (!bestAttempt) {
    return {
      allowed: false,
      reason: 'You must complete and pass the quiz for the previous video before proceeding',
      quizId: quiz.id,
      previousVideoId,
      bestScore: null,
      required: quiz.passingScore,
    };
  }

  if (bestAttempt.scorePercent < quiz.passingScore) {
    return {
      allowed: false,
      reason: 'You must pass the quiz for the previous video before proceeding',
      quizId: quiz.id,
      previousVideoId,
      bestScore: bestAttempt.scorePercent,
      required: quiz.passingScore,
    };
  }

  return { allowed: true };
}

// ─── Attempt Operations ───────────────────────────────────────────────────────

/**
 * Start or resume a quiz attempt for a user.
 * - If an IN_PROGRESS attempt exists → return it (resume).
 * - Otherwise → create a new attempt (attemptNumber = lastAttemptNumber + 1).
 *
 * @param {number} userId
 * @param {number} quizId
 * @returns {Promise<{ attempt: object, quiz: object, resumed: boolean }>}
 */
async function startAttempt(userId, quizId) {
  const quiz = await prisma.quiz.findUnique({ where: { id: quizId } });
  if (!quiz) throw Object.assign(new Error('Quiz not found'), { statusCode: 404 });

  // Check for existing IN_PROGRESS attempt to resume
  const inProgress = await prisma.quizAttempt.findFirst({
    where: { userId, quizId, status: STATUS.IN_PROGRESS },
    orderBy: { startedAt: 'desc' },
  });

  if (inProgress) {
    // Lazily expire if past deadline
    if (inProgress.deadlineAt && new Date() > new Date(inProgress.deadlineAt.getTime ? inProgress.deadlineAt.getTime() + GRACE_SEC * 1000 : Date.parse(inProgress.deadlineAt) + GRACE_SEC * 1000)) {
      const expired = await prisma.quizAttempt.update({
        where: { id: inProgress.id },
        data: { status: STATUS.EXPIRED, scorePercent: 0, earnedPoints: 0, totalPoints: computeTotalPoints(quiz.answerKey).totalPoints },
      });
      // Fall through to create a new attempt
    } else {
      return { attempt: inProgress, quiz, resumed: true };
    }
  }

  // Determine next attempt number
  const lastAttempt = await prisma.quizAttempt.findFirst({
    where: { userId, quizId },
    orderBy: { attemptNumber: 'desc' },
    select: { attemptNumber: true },
  });
  const attemptNumber = lastAttempt ? lastAttempt.attemptNumber + 1 : 1;

  // Compute deadline
  const startedAt = new Date();
  const deadlineAt = quiz.timeLimitSec ? new Date(startedAt.getTime() + quiz.timeLimitSec * 1000) : null;

  const attempt = await prisma.quizAttempt.create({
    data: { userId, quizId, attemptNumber, startedAt, deadlineAt, status: STATUS.IN_PROGRESS },
  });

  return { attempt, quiz, resumed: false };
}

/**
 * Submit quiz answers for an attempt.
 * Enforces server-side timer, auto-grades MCQs, computes scorePercent.
 * Status → GRADED (MCQ only) or GRADING (has essays).
 *
 * @param {number} userId
 * @param {number} attemptId
 * @param {object} responses - { [qName]: value }
 * @param {boolean} autoSubmitted
 * @returns {Promise<object>} Updated attempt
 */
async function submitAttempt(userId, attemptId, responses, autoSubmitted = false) {
  const serialized = JSON.stringify(responses);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SURVEY_JSON_BYTES) {
    throw Object.assign(new Error('Responses exceed the maximum allowed size.'), { statusCode: 413 });
  }

  const attempt = await prisma.quizAttempt.findUnique({
    where: { id: attemptId },
    include: { quiz: true },
  });

  if (!attempt) throw Object.assign(new Error('Attempt not found'), { statusCode: 404 });
  if (attempt.userId !== userId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
  if (attempt.status !== STATUS.IN_PROGRESS) {
    throw Object.assign(new Error(`Attempt is already ${attempt.status}`), { statusCode: 409 });
  }

  // Enforce deadline + grace
  if (attempt.deadlineAt) {
    const deadline = new Date(attempt.deadlineAt);
    deadline.setSeconds(deadline.getSeconds() + GRACE_SEC);
    if (new Date() > deadline) {
      await prisma.quizAttempt.update({
        where: { id: attemptId },
        data: { status: STATUS.EXPIRED, scorePercent: 0, earnedPoints: 0, totalPoints: computeTotalPoints(attempt.quiz.answerKey).totalPoints },
      });
      throw Object.assign(new Error('Submission deadline has passed. Attempt expired.'), { statusCode: 403 });
    }
  }

  const answerKey = attempt.quiz.answerKey;
  const { mcqEarned, totalMcqPoints, perQuestion } = gradeMcq(answerKey, responses);
  const { totalPoints, totalEssayPoints } = computeTotalPoints(answerKey);

  const hasEssays = totalEssayPoints > 0;

  // If no essays: immediately graded. If essays: status = GRADING (pending manual grade).
  const earnedPoints = hasEssays ? mcqEarned : mcqEarned; // essays add 0 until graded
  const scorePercent = hasEssays ? computeScorePercent(mcqEarned, totalPoints) : computeScorePercent(mcqEarned, totalPoints);
  const newStatus = hasEssays ? STATUS.GRADING : STATUS.GRADED;

  const updated = await prisma.quizAttempt.update({
    where: { id: attemptId },
    data: {
      status: newStatus,
      submittedAt: new Date(),
      autoSubmitted,
      responses,
      mcqEarned,
      essayEarned: hasEssays ? 0 : null,
      totalPoints,
      earnedPoints,
      scorePercent,
    },
  });

  return { attempt: updated, perQuestion, hasEssays };
}

/**
 * Save responses for an owned, in-progress attempt without grading or changing
 * its lifecycle status. The caller must still submit to trigger grading.
 *
 * @param {number} userId
 * @param {number} attemptId
 * @param {object} responses - { [qName]: value }
 * @returns {Promise<object>} Updated attempt identifier
 */
async function saveAttempt(userId, attemptId, responses) {
  const serialized = JSON.stringify(responses);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SURVEY_JSON_BYTES) {
    throw Object.assign(new Error('Responses exceed the maximum allowed size.'), { statusCode: 413 });
  }

  const attempt = await prisma.quizAttempt.findUnique({
    where: { id: attemptId },
    select: { id: true, userId: true, status: true },
  });

  if (!attempt) throw Object.assign(new Error('Attempt not found'), { statusCode: 404 });
  if (attempt.userId !== userId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
  if (attempt.status !== STATUS.IN_PROGRESS) {
    throw Object.assign(new Error(`Attempt is already ${attempt.status}`), { statusCode: 409 });
  }

  const updated = await prisma.quizAttempt.update({
    where: { id: attemptId },
    data: { responses },
    select: { id: true },
  });

  return updated;
}

/**
 * Grade essay questions for a submitted attempt.
 * Called by admin. Computes final scorePercent and sets status to GRADED.
 *
 * @param {number} adminId
 * @param {number} attemptId
 * @param {object} essayScores - { [qName]: awardedPoints }
 * @param {object} essayFeedbackMap - { [qName]: feedbackString }
 * @returns {Promise<object>} Updated attempt
 */
async function gradeEssayAttempt(adminId, attemptId, essayScores, essayFeedbackMap = {}) {
  const attempt = await prisma.quizAttempt.findUnique({
    where: { id: attemptId },
    include: { quiz: { select: { answerKey: true } } },
  });

  if (!attempt) throw Object.assign(new Error('Attempt not found'), { statusCode: 404 });
  if (attempt.status !== STATUS.GRADING) {
    throw Object.assign(new Error(`Attempt status is "${attempt.status}", expected GRADING`), { statusCode: 409 });
  }

  const answerKey = attempt.quiz.answerKey;
  let essayEarned = 0;
  const feedbackRecord = {};

  for (const [qName, awardedPts] of Object.entries(essayScores)) {
    const keyEntry = answerKey[qName];
    if (!keyEntry || keyEntry.type !== 'comment') continue;
    const pts = Math.min(Math.max(0, Number(awardedPts)), keyEntry.points); // clamp 0..max
    essayEarned += pts;
    feedbackRecord[qName] = {
      awarded: pts,
      max: keyEntry.points,
      feedback: essayFeedbackMap[qName] || null,
    };
  }

  const totalPoints = attempt.totalPoints || 0;
  const mcqEarned = attempt.mcqEarned || 0;
  const earnedPoints = mcqEarned + essayEarned;
  const scorePercent = computeScorePercent(earnedPoints, totalPoints);

  const updated = await prisma.quizAttempt.update({
    where: { id: attemptId },
    data: {
      status: STATUS.GRADED,
      essayEarned,
      earnedPoints,
      scorePercent,
      essayFeedback: feedbackRecord,
      essayGradedBy: adminId,
      essayGradedAt: new Date(),
    },
  });

  return updated;
}

// ─── Image Upload ─────────────────────────────────────────────────────────────

/**
 * Upload a question image to BunnyCDN storage and return the CDN URL.
 * Relies on bunnyStreamClient's uploadThumbnail or a similar storage call.
 *
 * @param {Buffer} fileBuffer
 * @param {string} mimeType  - e.g. 'image/png'
 * @param {string} filename  - original filename for extension detection
 * @returns {Promise<{ url: string }>}
 */
async function uploadQuestionImage(fileBuffer, mimeType, filename) {
  // Delegate to the existing Bunny client storage upload helper
  if (typeof bunny.uploadThumbnail !== 'function') {
    throw Object.assign(new Error('Image upload to BunnyCDN is not configured'), { statusCode: 501 });
  }
  const url = await bunny.uploadThumbnail(fileBuffer, filename, mimeType);
  return { url };
}

module.exports = {
  validateSurveyJson,
  buildAnswerKey,
  sanitizeForStudent,
  gradeMcq,
  computeTotalPoints,
  computeScorePercent,
  evaluateGate,
  startAttempt,
  submitAttempt,
  saveAttempt,
  gradeEssayAttempt,
  uploadQuestionImage,
};
