'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticateToken, authorizeAdmin, isAdmin } = require('../../middlewares/index');
const { createRateLimitStore } = require('../../integrations/redis/rateLimitStore');
const { isRedisEnabled } = require('../../integrations/redis/redisClient');
const config = require('../../config/env');
const gamificationService = require('./gamification.service');
const { upsertChallengeSchema } = require('./gamification.validation');

const redisStoreEnabled = isRedisEnabled();
const requireRedis = Boolean(config.rateLimit && config.rateLimit.requireRedis);

const studentReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { success: false, error: 'Too many gamification requests. Please wait a moment.', code: 'RATE_LIMIT_EXCEEDED' },
  keyGenerator: (req) => (req.user && req.user.id ? `u:${req.user.id}` : `ip:${req.ip}`),
  validate: { ip: false },
  ...(redisStoreEnabled ? { store: createRateLimitStore('rl:gamify:read:', { failClosed: requireRedis }) } : {}),
});

const adminWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { success: false, error: 'Too many admin challenge requests. Please wait a moment.', code: 'RATE_LIMIT_EXCEEDED' },
  keyGenerator: (req) => (req.user && req.user.id ? `u:${req.user.id}` : `ip:${req.ip}`),
  validate: { ip: false },
  ...(redisStoreEnabled ? { store: createRateLimitStore('rl:gamify:admin:', { failClosed: requireRedis }) } : {}),
});

// ── Student Gamification Router (/gamification & /api/gamification) ───────────
const gamificationRouter = express.Router();
gamificationRouter.use(authenticateToken, studentReadLimiter);

gamificationRouter.get('/hud', async (req, res) => {
  try {
    const tenantId = gamificationService.getTenantId(req);
    const data = await gamificationService.getHud(tenantId, req.user.id);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error('[GamificationRoutes] GET /hud error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load gamification HUD' });
  }
});

gamificationRouter.get('/summary', async (req, res) => {
  try {
    const tenantId = gamificationService.getTenantId(req);
    const data = await gamificationService.getSummary(tenantId, req.user.id);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error('[GamificationRoutes] GET /summary error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load gamification summary' });
  }
});

// ── Course Challenge Router (mounted at / and /api) ───────────────────────────
const challengeRouter = express.Router();

challengeRouter.get(
  '/courses/:courseSlug/challenge',
  authenticateToken,
  studentReadLimiter,
  async (req, res) => {
    try {
      const tenantId = gamificationService.getTenantId(req);
      const userIsAdmin = await isAdmin(req);
      const data = await gamificationService.getCourseChallenge(
        tenantId,
        req.user.id,
        req.params.courseSlug,
        userIsAdmin
      );
      return res.status(200).json({ success: true, data });
    } catch (err) {
      const statusCode = err.statusCode || 500;
      if (statusCode >= 500) {
        console.error('[GamificationRoutes] GET /courses/:courseSlug/challenge error:', err);
      }
      return res.status(statusCode).json({
        success: false,
        error: statusCode >= 500 ? 'Failed to load course challenge' : err.message,
        ...(err.code ? { code: err.code } : {}),
      });
    }
  }
);

challengeRouter.put(
  '/admin/courses/:courseSlug/challenge',
  authenticateToken,
  authorizeAdmin(),
  adminWriteLimiter,
  async (req, res) => {
    try {
      const parsed = upsertChallengeSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid challenge payload',
          details: parsed.error.issues,
        });
      }

      const tenantId = gamificationService.getTenantId(req);
      const data = await gamificationService.upsertCourseChallenge(
        tenantId,
        req.params.courseSlug,
        parsed.data
      );
      return res.status(200).json({ success: true, data });
    } catch (err) {
      const statusCode = err.statusCode || 500;
      if (statusCode >= 500) {
        console.error('[GamificationRoutes] PUT /admin/courses/:courseSlug/challenge error:', err);
      }
      return res.status(statusCode).json({
        success: false,
        error: statusCode >= 500 ? 'Failed to save course challenge' : err.message,
        ...(err.code ? { code: err.code } : {}),
      });
    }
  }
);

module.exports = {
  gamificationRouter,
  challengeRouter,
};
