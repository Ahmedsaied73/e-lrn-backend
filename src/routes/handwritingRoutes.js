'use strict';

/**
 * handwritingRoutes.js — Handwriting recognition route shell.
 *
 * Implements Plan §8.1:
 * - Route: POST /api/handwriting/recognize (also mounted at /recognize when prefixed).
 * - Auth: authenticated students only (authenticateToken).
 * - Rate limiting: 20 requests per minute per user (Redis-backed with in-memory fallback).
 * - Flag check: returns 404 when HANDWRITING_ENABLED is false.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticateToken } = require('../middlewares/index');
const { createRateLimitStore } = require('../integrations/redis/rateLimitStore');
const { isRedisEnabled } = require('../integrations/redis/redisClient');
const config = require('../config/env');
const { recognizeHandwriting } = require('../controllers/handwritingController');

const router = express.Router();

// Rate limiter: 20 req/min per authenticated user
const handwritingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 req/min
  message: {
    error: 'Too many handwriting recognition requests. Please wait a moment.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  keyGenerator: (req) => (req.user && req.user.id ? `u:${req.user.id}` : `ip:${req.ip}`),
  validate: { ip: false },
  ...(isRedisEnabled()
    ? { store: createRateLimitStore('rl:handwriting:', { failClosed: config.rateLimit.requireRedis }) }
    : {}),
});

// Mounted as POST /api/handwriting/recognize or POST /handwriting/recognize
router.post('/recognize', authenticateToken, handwritingLimiter, recognizeHandwriting);
// Direct alias if mounted at /
router.post('/api/handwriting/recognize', authenticateToken, handwritingLimiter, recognizeHandwriting);

module.exports = router;
