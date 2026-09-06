'use strict';

const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeAdmin } = require('../middlewares/index');
const { getDashboardStats } = require('../controllers/adminController');
const { listAllQuizzes, listAllAttempts } = require('../controllers/quizController');
const { listAllEnrollments, adminEnroll, unenroll } = require('../controllers/enrollmentController');

// Every admin route requires an authenticated ADMIN user.
router.use(authenticateToken, authorizeAdmin());

router.get('/dashboard', getDashboardStats);
router.get('/quizzes', listAllQuizzes);
router.get('/attempts', listAllAttempts);
router.get('/enrollments', listAllEnrollments);
router.post('/enrollments', adminEnroll);
router.delete('/enrollments/:id', unenroll);

module.exports = router;