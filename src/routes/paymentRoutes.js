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
const rateLimit = require('express-rate-limit');
const { authenticateToken } = require('../middlewares/index');
const { createRateLimitStore } = require('../integrations/redis/rateLimitStore');
const { isRedisEnabled } = require('../integrations/redis/redisClient');
const config = require('../config/env');
const {
  createCheckout,
  getStatus,
  getHistory,
} = require('../controllers/paymentController');

const router = express.Router();

// Per-USER checkout limiter. Each call can create a Paymob intention, so it
// must be bounded (approved plan item) — and keyed on the authenticated user
// id, not the IP, so one student behind a shared NAT cannot starve others.
// Mounted AFTER authenticateToken for that reason. `PAYMENTS_CHECKOUT_LIMIT`
// is env-tunable; 15/15min is far above any legitimate flow because the
// one-open-checkout rule (D5) reuses an existing session instead of creating
// a new one.
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PAYMENTS_CHECKOUT_LIMIT) || 15,
  message: 'Too many payment attempts, please try again later.',
  keyGenerator: (req) => (req.user && req.user.id ? `u:${req.user.id}` : `ip:${req.ip}`),
  ...(isRedisEnabled() ? { store: createRateLimitStore('rl:checkout:', { failClosed: config.rateLimit.requireRedis }) } : {}),
});

// Start (or resume) a Paymob checkout for a course. Body: { courseSlug }.
router.post('/checkout', authenticateToken, checkoutLimiter, createCheckout);

// Poll a payment's status from the result page. Path: our providerReference.
router.get('/status/:providerReference', authenticateToken, getStatus);

// The student's own payment history (no one else's).
router.get('/history', authenticateToken, getHistory);

module.exports = router;

