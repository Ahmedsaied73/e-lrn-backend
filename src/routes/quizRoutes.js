const express = require('express');
const { 
  createQuiz, 
  getQuiz, 
  submitQuizAnswers, 
  getQuizResults,
  getCourseQuizzes
} = require('../controllers/quizController');
const { authenticateToken, authorizeAdmin } = require('../middlewares');

const router = express.Router();

// Create a new quiz (admin only)
router.post('/', authenticateToken, authorizeAdmin(), createQuiz);

// Get a quiz by ID
router.get('/:id', authenticateToken, getQuiz);

// Submit answers for a quiz
router.post('/submit', authenticateToken, submitQuizAnswers);

// Get quiz results for a user
router.get('/:quizId/results', authenticateToken, getQuizResults);

// Get all quizzes for a course
router.get('/course/:courseId', authenticateToken, getCourseQuizzes);

module.exports = router;