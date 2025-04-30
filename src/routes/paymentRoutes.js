const express = require('express');
const { authenticateToken } = require('../middlewares');
const {
  processCoursePayment,
  getPaymentHistory
} = require('../controllers/paymentController');

const router = express.Router();

// Process a payment for a course
router.post('/course/:courseId', authenticateToken, processCoursePayment);

// Get payment history for the user
router.get('/history', authenticateToken, getPaymentHistory);

module.exports = router; 