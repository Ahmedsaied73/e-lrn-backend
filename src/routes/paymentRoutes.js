'use strict';

/**
 * Payment HTTP surface (D13/D14/D16).
 *
 *   POST /payments/checkout           → hosted checkout URL (authenticated)
 *   GET  /payments/status/:reference  → result-page polling (owner only)
 *   GET  /payments/history            → own payment history
 *
 * The legacy stub route (POST /payments/course/:id) is DELETED, not kept —
 * per the locked plan, and safe: it always 403'd in production.
 *
 * This router is mounted ONLY when payments are enabled (app.js) — see the
 * optional-modules block. It is never required at boot otherwise.
 */
const express = require('express');
const { authenticateToken } = require('../middlewares/index');
const {
  createCheckout,
  getStatus,
  getHistory,
} = require('../controllers/paymentController');

const router = express.Router();

// Start (or resume) a Paymob checkout for a course. Body: { courseSlug }.
router.post('/checkout', authenticateToken, createCheckout);

// Poll a payment's status from the result page. Path: our providerReference.
router.get('/status/:providerReference', authenticateToken, getStatus);

// The student's own payment history (no one else's).
router.get('/history', authenticateToken, getHistory);

module.exports = router;

