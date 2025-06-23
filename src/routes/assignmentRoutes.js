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
const { authenticateToken, authorizeAdmin } = require('../middlewares');

const router = express.Router();

// Create a new assignment (admin only)
router.post('/', authenticateToken, authorizeAdmin(), createAssignment);

// Get an assignment by ID
router.get('/:id', authenticateToken, getAssignment);

// Submit an assignment (works for both regular and MCQ assignments)
router.post('/submit', authenticateToken, submitAssignment);

// Grade a submission (admin only) - for non-MCQ assignments
router.post('/submissions/:submissionId/grade', authenticateToken, authorizeAdmin(), gradeSubmission);

// Get all assignments for a video
router.get('/video/:videoId', authenticateToken, getVideoAssignments);

// Get all submissions by the current user - this route must come BEFORE the wildcard route below
router.get('/user/submissions', authenticateToken, getUserSubmissions);

// Get the status of a specific assignment for the current user
router.get('/:assignmentId/status', authenticateToken, getAssignmentStatus);

// Get all submissions for an assignment (admin only)
router.get('/:assignmentId/submissions', authenticateToken, authorizeAdmin(), getAssignmentSubmissions);

// Get all assignments for a course (with related video info)
router.get('/course/:courseId', authenticateToken, getCourseAssignments);

module.exports = router;