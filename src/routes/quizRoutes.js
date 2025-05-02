const express = require('express');
const { 
  createQuiz, 
  getQuiz, 
  submitQuizAnswers, 
  getQuizResults,
  getCourseQuizzes,
  getUserQuizResults
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

// Get all quiz results for the authenticated user
router.get('/user/results', authenticateToken, getUserQuizResults);

module.exports = router;