'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticateToken, authorizeAdmin } = require('../middlewares/index');
const { createRateLimitStore } = require('../integrations/redis/rateLimitStore');
const { isRedisEnabled } = require('../integrations/redis/redisClient');
const config = require('../config/env');
const {
  generateBatch,
  getBatches,
  getBatchDetails,
  downloadBatchCsv,
  revokeCode,
  revokeBatch,
  lookupCode,
  redeemCode,
} = require('../controllers/accessCodeController');

const router = express.Router();

// Dedicated rate limiter for student redemption attempts: 5 attempts per 15 minutes
const redeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    error: 'حاولت مرات كثيرة. حاول مرة أخرى بعد قليل',
    code: 'RATE_LIMITED',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user && req.user.id ? `u:${req.user.id}` : `ip:${req.ip}`),
  ...(isRedisEnabled()
    ? { store: createRateLimitStore('rl:redeem:', { failClosed: config.rateLimit.requireRedis }) }
    : {}),
});

// ── Student Endpoints ────────────────────────────────────────────────────────
router.post('/redeem', authenticateToken, redeemLimiter, redeemCode);

// ── Admin Endpoints (Require authenticateToken + authorizeAdmin) ─────────────
const adminAuth = [authenticateToken, authorizeAdmin()];

router.post('/generate', ...adminAuth, generateBatch);
router.get('/batches', ...adminAuth, getBatches);
router.get('/batches/:id', ...adminAuth, getBatchDetails);
router.get('/batches/:id/download', ...adminAuth, downloadBatchCsv);
router.post('/revoke', ...adminAuth, revokeCode);
router.post('/revoke-batch', ...adminAuth, revokeBatch);
router.get('/lookup/:code', ...adminAuth, lookupCode);

module.exports = router;
