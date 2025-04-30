// routes/enrollmentRoutes.js

const express = require('express');
const { enrollUserInCourse, checkEnrollmentStatus } = require('../controllers/enrollmentController');
const { authenticateToken } = require('../middlewares');

const enrollrouter = express.Router();

enrollrouter.post('/api/enroll',authenticateToken, enrollUserInCourse);
enrollrouter.post('/api/enrollment-status', authenticateToken, checkEnrollmentStatus);

module.exports = enrollrouter;
