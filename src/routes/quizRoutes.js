'use strict';

/**
 * quizRoutes.js
 * Declarative Express router for SurveyJS-backed Quiz API.
 * Mounted in app.js as: app.use('/quizzes', quizRoutes);
 */

const express = require('express');
const router = express.Router();

const { authenticateToken, authorizeAdmin } = require('../middlewares/index');
const {
  getQuizMeta,
  startQuiz,
  submitQuiz,
  getQuizResult,
  getStudentAttempts,
  upsertQuiz,
  deleteQuiz,
  listQuizAttempts,
  gradeAttempt,
  resetAttempt,
  grantExemption,
  revokeExemption,
} = require('../controllers/quizController');

// All quiz routes require valid authentication
router.use(authenticateToken);

// ─── Student Endpoints ────────────────────────────────────────────────────────

// Drives "بدء الاختبار" button: check if quiz exists, unlock status, best score
router.get('/videos/:videoId/meta', getQuizMeta);

// Start or resume an attempt -> returns sanitized surveyJson & deadlineAt
router.post('/videos/:videoId/start', startQuiz);

// Submit answers for grading
router.post('/attempts/:id/submit', submitQuiz);

// View score and detailed breakdown (with model answers post-submit)
router.get('/attempts/:id/result', getQuizResult);

// List historical attempts for student
router.get('/videos/:videoId/attempts', getStudentAttempts);

// ─── Admin Endpoints ──────────────────────────────────────────────────────────

// Create / update quiz definition for a video
router.post('/videos/:videoId', authorizeAdmin(), upsertQuiz);

// Delete quiz and associated attempts
router.delete('/:quizId', authorizeAdmin(), deleteQuiz);

// View attempt list / grading queue
router.get('/:quizId/attempts', authorizeAdmin(), listQuizAttempts);

// Grade essay questions
router.put('/attempts/:id/grade', authorizeAdmin(), gradeAttempt);

// Reset a student attempt
router.post('/attempts/:id/reset', authorizeAdmin(), resetAttempt);

// Grant sequential gate exemption
router.post('/videos/:videoId/exemptions', authorizeAdmin(), grantExemption);

// Revoke sequential gate exemption
router.delete('/exemptions/:exemptionId', authorizeAdmin(), revokeExemption);

module.exports = router;
