const express = require('express');
const { 
  createAssignment, 
  getAssignment, 
  submitAssignment, 
  gradeSubmission,
  getVideoAssignments,
  getAssignmentSubmissions,
  getUserSubmissions
} = require('../controllers/assignmentController');
const { authenticateToken, authorizeAdmin } = require('../middlewares');

const router = express.Router();

// Create a new assignment (admin only)
router.post('/', authenticateToken, authorizeAdmin(), createAssignment);

// Get an assignment by ID
router.get('/:id', authenticateToken, getAssignment);

// Submit an assignment
router.post('/submit', authenticateToken, submitAssignment);

// Grade a submission (admin only)
router.post('/submissions/:submissionId/grade', authenticateToken, authorizeAdmin(), gradeSubmission);

// Get all assignments for a video
router.get('/video/:videoId', authenticateToken, getVideoAssignments);

// Get all submissions for an assignment (admin only)
router.get('/:assignmentId/submissions', authenticateToken, authorizeAdmin(), getAssignmentSubmissions);

// Get all submissions by the current user
router.get('/user/submissions', authenticateToken, getUserSubmissions);

module.exports = router;