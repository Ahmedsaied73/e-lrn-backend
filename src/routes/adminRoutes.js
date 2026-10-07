'use strict';

const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeAdmin } = require('../middlewares/index');
const { getDashboardStats } = require('../controllers/adminController');
const { listAllQuizzes, listAllAttempts } = require('../controllers/quizController');
const { listAllEnrollments, adminEnroll, unenroll } = require('../controllers/enrollmentController');
const { listAiGradingJobs, retryFailedAiGrading } = require('../controllers/aiGraderAdminController');
const {
  getStudentDevicesAdmin,
  unbindDeviceAdmin,
  resetStudentDevicesAdmin,
  updateStudentDeviceLimitAdmin,
} = require('../controllers/deviceController');
// Read-only payments list (P2/D9). Mounted UNCONDITIONALLY — unlike the student
// surface — so an admin can still audit past payments after the flag is turned
// off. The controller depends on prisma only (not the payments service), so it
// keeps working even if src/services/payments is deleted (removal test).
const { listAllPayments } = require('../controllers/adminPaymentsController');

// Every admin route requires an authenticated ADMIN user.
router.use(authenticateToken, authorizeAdmin());

router.get('/dashboard', getDashboardStats);
router.get('/quizzes', listAllQuizzes);
router.get('/attempts', listAllAttempts);
router.get('/enrollments', listAllEnrollments);
router.post('/enrollments', adminEnroll);
router.delete('/enrollments/:id', unenroll);

// Payments (P2/D9): read-only triage list for mismatches/duplicate charges.
router.get('/payments', listAllPayments);

// Student device binding management (Admin)
router.get('/users/:userSlug/devices', getStudentDevicesAdmin);
router.delete('/users/:userSlug/devices/:deviceIdentifier', unbindDeviceAdmin);
router.post('/users/:userSlug/devices/reset', resetStudentDevicesAdmin);
router.patch('/users/:userSlug/device-limit', updateStudentDeviceLimitAdmin);
router.put('/users/:userSlug/device-limit', updateStudentDeviceLimitAdmin);

// AI-grading failed-job surfacing (J1/T4.1) — durable AiGradingJob rows.
router.get('/ai-grading/jobs', listAiGradingJobs);
router.post('/ai-grading/retry', retryFailedAiGrading);

module.exports = router;