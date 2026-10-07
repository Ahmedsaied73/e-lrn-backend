'use strict';

const prisma = require('../config/db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { jwt: jwtConfig } = require('../config/env');
const { createToken, createRefreshToken, hashRefreshToken, createRefreshTokenFamily } = require('../utils');
const { accessTokenCookieOptions, refreshTokenCookieOptions } = require('../config/cookie');
const { getLockState, recordFailure, clearFailures } = require('../integrations/redis/accountLockout');
const { randomBase36Slug } = require('../utils/slugs');
const { createSemaphore } = require('../utils/concurrency');
const deviceService = require('../services/deviceService');
const { AppError } = require('../utils/AppError');
const { isValidDeviceId } = require('../utils/deviceHelper');

// Bounds simultaneous credential checks. Pending logins queue in the semaphore
// (no DB pool held) instead of stamping the pool with serial round-trips.
// LOGIN_CONCURRENCY env-tunable; 8 matches the measured pool headroom.
const loginSlot = createSemaphore(Number(process.env.LOGIN_CONCURRENCY) || 8);

async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    // Consecutive-failure lockout (Redis-backed, fail-open when Redis is off).
    // Checked BEFORE any credential work so a brute-forcer spends nothing per
    // attempt while locked. Responds 423 with Retry-After when locked.
    const lockState = await getLockState(email);
    if (lockState.locked) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(lockState.retryAfterMs / 1000))));
      return res.status(423).json({
        success: false,
        error: 'Too many failed attempts. Try again later.',
        code: 'ACCOUNT_LOCKED',
      });
    }

    // Credential-check section (user fetch + bcrypt compare) bounded by the
    // login semaphore: pending logins wait here WITHOUT holding a DB pool
    // connection. All 401/lockout semantics below are unchanged.
    const { user, passwordMatch } = await loginSlot(async () => {
      const found = await prisma.user.findUnique({
        where: { email: email.trim().toLowerCase() }
      });

      if (!found) return { user: null, passwordMatch: false };

      const ok = await bcrypt.compare(password, found.password);
      return { user: found, passwordMatch: ok };
    });

    if (!user) {
      await recordFailure(email);
      return res.status(401).json({ success: false, error: 'Invalid credentials.' });
    }

    if (!passwordMatch) {
      await recordFailure(email);
      return res.status(401).json({ success: false, error: 'Invalid credentials.' });
    }

    // Success clears the failure counter.
    await clearFailures(email);

    // Device binding & validation
    const devicePayload = req.body.device || (req.headers['x-device-id'] ? { id: req.headers['x-device-id'] } : null);
    const device = await deviceService.validateOrRegisterDevice({
      user,
      devicePayload,
      ip: req.ip || req.connection?.remoteAddress,
      userAgent: req.headers['user-agent'] || '',
    });

    const payload = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      deviceId: device.deviceIdentifier,
    };
    const token = createToken(payload, jwtConfig.secret);
    const refreshToken = createRefreshToken(payload, jwtConfig.refreshSecret);

    // Fresh login = a NEW family for this specific device.
    // Stored directly on UserDevice (isolated multi-device sessions).
    const family = createRefreshTokenFamily();
    await prisma.userDevice.update({
      where: { id: device.id },
      data: {
        refreshToken: hashRefreshToken(refreshToken),
        refreshTokenFamily: family,
        lastActiveAt: new Date(),
      },
    });

    await prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
      },
    });

    // lastLoginAt is part of the cached /user/me payload (v1:me:{id}) — drop it.
    try {
      const cache = require('../integrations/redis/cache');
      await cache.del(cache.buildKey('me', String(user.id)));
    } catch {
      /* best-effort */
    }

    // Set HttpOnly Cookies on Response.
    res.cookie('accessToken', token, accessTokenCookieOptions);
    res.cookie('refreshToken', refreshToken, refreshTokenCookieOptions);

    return res.json({ success: true, data: { user: payload } });
  } catch (error) {
    if (error instanceof AppError || (error.statusCode && error.code)) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code,
      });
    }
    console.error('Login error:', error);
    return res.status(500).json({ success: false, error: 'An error occurred during login.' });
  }
}

async function register(req, res) {
  const { email, password, name, phoneNumber, grade } = req.body;

  if (!email || typeof email !== 'string') return res.status(400).json({ success: false, error: 'Email is required.' });
  if (!password || typeof password !== 'string') return res.status(400).json({ success: false, error: 'Password is required.' });
  if (password.length < 8) return res.status(400).json({ success: false, error: 'Password must be at least 8 characters.' });
  if (!name || typeof name !== 'string') return res.status(400).json({ success: false, error: 'Name is required.' });
  if (!phoneNumber) return res.status(400).json({ success: false, error: 'Phone number is required.' });
  if (!grade) return res.status(400).json({ success: false, error: 'Grade is required (FIRST_SECONDARY, SECOND_SECONDARY, or THIRD_SECONDARY).' });

  const allowedGrades = ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'];
  if (!allowedGrades.includes(grade)) {
    return res.status(400).json({ success: false, error: 'Invalid grade value. Must be one of: FIRST_SECONDARY, SECOND_SECONDARY, THIRD_SECONDARY.' });
  }

  try {
    const existingUser = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (existingUser) return res.status(409).json({ success: false, error: 'An account with these details already exists.' });

    const existingPhone = await prisma.user.findUnique({ where: { phoneNumber: phoneNumber.trim() } });
    if (existingPhone) return res.status(409).json({ success: false, error: 'An account with these details already exists.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await prisma.user.create({
      data: { name: name.trim(), email: email.trim().toLowerCase(), phoneNumber: phoneNumber.trim(), password: hashedPassword, grade, slug: randomBase36Slug() }
    });

    const devicePayload = req.body.device || (req.headers['x-device-id'] ? { id: req.headers['x-device-id'] } : null);
    let device = null;

    if (!req.user) {
      // Public self-registration: register Device #1
      const effectivePayload = (devicePayload && isValidDeviceId(devicePayload.id))
        ? devicePayload
        : { id: 'reg_' + Buffer.from(randomBase36Slug()).toString('hex').slice(0, 16) + '_' + Date.now() };

      device = await deviceService.validateOrRegisterDevice({
        user: newUser,
        devicePayload: effectivePayload,
        ip: req.ip || req.connection?.remoteAddress,
        userAgent: req.headers['user-agent'] || '',
      });
    }

    const payload = {
      id: newUser.id,
      slug: newUser.slug,
      email: newUser.email,
      name: newUser.name,
      phoneNumber: newUser.phoneNumber,
      grade: newUser.grade,
      role: newUser.role,
      ...(device ? { deviceId: device.deviceIdentifier } : {}),
    };
    const token = createToken(payload, jwtConfig.secret);
    const refreshToken = createRefreshToken(payload, jwtConfig.refreshSecret);

    if (device) {
      await prisma.userDevice.update({
        where: { id: device.id },
        data: {
          refreshToken: hashRefreshToken(refreshToken),
          refreshTokenFamily: createRefreshTokenFamily(),
          lastActiveAt: new Date(),
        },
      });
    }

    // Set HttpOnly Cookies ONLY when there is no existing session.
    if (!req.user) {
      res.cookie('accessToken', token, accessTokenCookieOptions);
      res.cookie('refreshToken', refreshToken, refreshTokenCookieOptions);
    }

    return res.status(201).json({ success: true, message: 'User registered successfully.', data: { user: payload } });
  } catch (error) {
    if (error instanceof AppError || (error.statusCode && error.code)) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
        code: error.code,
      });
    }
    console.error('Registration error:', error);
    return res.status(500).json({ success: false, error: 'An error occurred during registration.' });
  }
}

async function logout(req, res) {
  try {
    const token = req.cookies && req.cookies.refreshToken;
    if (token) {
      try {
        const decoded = jwt.verify(token, jwtConfig.refreshSecret);
        if (decoded.deviceId) {
          await prisma.userDevice.updateMany({
            where: {
              userId: decoded.id,
              deviceIdentifier: decoded.deviceId,
            },
            data: {
              refreshToken: null,
            },
          });
        } else {
          await prisma.user.update({
            where: { id: decoded.id },
            data: { refreshToken: null },
          }).catch(() => {});
        }
      } catch {
        // Silently ignore if token is invalid or expired
      }
    }

    res.clearCookie('accessToken', { ...accessTokenCookieOptions, maxAge: 0 });
    res.clearCookie('refreshToken', { ...refreshTokenCookieOptions, maxAge: 0 });

    return res.json({ success: true, message: 'Logged out successfully.' });
  } catch (error) {
    console.error('Logout error:', error);
    return res.status(500).json({ success: false, error: 'An error occurred during logout.' });
  }
}

async function refreshToken(req, res) {
  const token = req.cookies && req.cookies.refreshToken;
  if (!token) return res.status(401).json({ success: false, error: 'Refresh token not provided.' });

  try {
    const decoded = jwt.verify(token, jwtConfig.refreshSecret);

    // Reject access tokens handed to refresh endpoint
    if (decoded.type !== 'refresh') {
      return res.status(403).json({ success: false, error: 'Invalid or revoked refresh token.' });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, name: true, role: true, maxDevices: true },
    });

    if (!user) {
      return res.status(403).json({ success: false, error: 'Invalid or revoked refresh token.' });
    }

    // Multi-device path if token has deviceId
    if (decoded.deviceId) {
      const device = await prisma.userDevice.findUnique({
        where: {
          userId_deviceIdentifier: {
            userId: user.id,
            deviceIdentifier: decoded.deviceId,
          },
        },
      });

      if (!device || device.revokedAt !== null) {
        res.clearCookie('accessToken', { ...accessTokenCookieOptions, maxAge: 0 });
        res.clearCookie('refreshToken', { ...refreshTokenCookieOptions, maxAge: 0 });
        return res.status(403).json({
          success: false,
          error: 'تم إلغاء ربط هذا الجهاز. يرجى إعادة تسجيل الدخول.',
          code: 'DEVICE_REVOKED',
        });
      }

      if (!device.refreshToken) {
        return res.status(403).json({ success: false, error: 'Invalid or revoked refresh token.' });
      }

      const stored = device.refreshToken;
      const isHashed = /^[0-9a-f]{64}$/.test(stored);
      const tokenValid = isHashed ? stored === hashRefreshToken(token) : stored === token;

      if (!tokenValid) {
        // REUSE DETECTED on this device: revoke this device's session
        await prisma.userDevice.update({
          where: { id: device.id },
          data: { refreshToken: null, refreshTokenFamily: null },
        });
        return res.status(403).json({ success: false, error: 'Invalid or revoked refresh token.' });
      }

      const payload = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        deviceId: device.deviceIdentifier,
      };
      const newToken = createToken(payload, jwtConfig.secret);
      const newRefreshToken = createRefreshToken(payload, jwtConfig.refreshSecret);
      const family = device.refreshTokenFamily || createRefreshTokenFamily();

      await prisma.userDevice.update({
        where: { id: device.id },
        data: {
          refreshToken: hashRefreshToken(newRefreshToken),
          refreshTokenFamily: family,
          lastActiveAt: new Date(),
          ipAddress: req.ip || req.connection?.remoteAddress,
        },
      });

      res.cookie('accessToken', newToken, accessTokenCookieOptions);
      res.cookie('refreshToken', newRefreshToken, refreshTokenCookieOptions);

      return res.json({ success: true, message: 'Token refreshed successfully.' });
    }

    // Legacy fallback (no deviceId in token)
    const userLegacy = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { refreshToken: true, refreshTokenFamily: true },
    });

    if (!userLegacy || userLegacy.refreshToken === null) {
      return res.status(403).json({ success: false, error: 'Invalid or revoked refresh token.' });
    }

    const stored = userLegacy.refreshToken;
    const isHashed = /^[0-9a-f]{64}$/.test(stored);
    const tokenValid = isHashed ? stored === hashRefreshToken(token) : stored === token;

    if (!tokenValid) {
      await prisma.user.update({
        where: { id: user.id },
        data: { refreshToken: null, refreshTokenFamily: null },
      });
      return res.status(403).json({ success: false, error: 'Invalid or revoked refresh token.' });
    }

    const payload = { id: user.id, email: user.email, name: user.name, role: user.role };
    const newToken = createToken(payload, jwtConfig.secret);
    const newRefreshToken = createRefreshToken(payload, jwtConfig.refreshSecret);
    const family = userLegacy.refreshTokenFamily || createRefreshTokenFamily();
    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: hashRefreshToken(newRefreshToken), refreshTokenFamily: family },
    });

    res.cookie('accessToken', newToken, accessTokenCookieOptions);
    res.cookie('refreshToken', newRefreshToken, refreshTokenCookieOptions);

    return res.json({ success: true, message: 'Token refreshed successfully.' });
  } catch (error) {
    console.error('Token refresh error:', error);
    return res.status(401).json({ success: false, error: 'Invalid refresh token.' });
  }
}

module.exports = { login, register, logout, refreshToken };