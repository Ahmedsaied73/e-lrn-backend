const express = require('express');
const { 
  createAssignment, 
  getAssignment, 
  submitAssignment, 
  gradeSubmission,
  getVideoAssignments,
  getAssignmentSubmissions,
  getUserSubmissions,
  getAssignmentStatus,
  getCourseAssignments
} = require('../controllers/assignmentController');
const { authenticateToken, authorizeAdmin } = require('../middlewares/index');

const router = express.Router();

// Create a new assignment (admin only)
router.post('/', authenticateToken, authorizeAdmin(), createAssignment);

// Submit an assignment (works for both regular and MCQ assignments)
router.post('/submit', authenticateToken, submitAssignment);

// Grade a submission (admin only) - for non-MCQ assignments
router.post('/submissions/:submissionId/grade', authenticateToken, authorizeAdmin(), gradeSubmission);

// Specific GET routes MUST come before wildcard /:id route
router.get('/user/submissions', authenticateToken, getUserSubmissions);
router.get('/video/:videoId', authenticateToken, getVideoAssignments);
router.get('/course/:courseId', authenticateToken, getCourseAssignments);

// Get the status of a specific assignment for the current user
router.get('/:assignmentId/status', authenticateToken, getAssignmentStatus);

// Get all submissions for an assignment (admin only)
router.get('/:assignmentId/submissions', authenticateToken, authorizeAdmin(), getAssignmentSubmissions);

// Get an assignment by ID (Wildcard route placed at bottom)
router.get('/:id', authenticateToken, getAssignment);

module.exports = router;
