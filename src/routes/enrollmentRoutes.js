const express = require('express');
const { enrollUserInCourse, checkEnrollmentStatus } = require('../controllers/enrollmentController');
const { authenticateToken } = require('../middlewares/index');

const enrollRouter = express.Router();

// POST /enroll/  — enroll authenticated user in a course
enrollRouter.post('/', authenticateToken, enrollUserInCourse);

// POST /enroll/status  — check authenticated user's enrollment status
enrollRouter.post('/status', authenticateToken, checkEnrollmentStatus);

module.exports = enrollRouter;
