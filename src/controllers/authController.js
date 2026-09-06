const prisma = require('../config/db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { jwt: jwtConfig } = require('../config/env');
const { createToken, createRefreshToken } = require('../utils');
const { accessTokenCookieOptions, refreshTokenCookieOptions } = require('../config/cookie');

async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() }
    });

    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return res.status(401).json({ success: false, error: 'Invalid credentials.' });
    }

    const payload = { id: user.id, email: user.email, name: user.name, role: user.role };
    const token = createToken(payload, jwtConfig.secret);
    const refreshToken = createRefreshToken(payload, jwtConfig.refreshSecret);

    // Save refresh token in DB for revocation support
    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken }
    });

    // Set HttpOnly Cookies on Response. Tokens are NEVER returned in the body —
    // the browser holds them in cookies (cookie-only auth model).
    res.cookie('accessToken', token, accessTokenCookieOptions);
    res.cookie('refreshToken', refreshToken, refreshTokenCookieOptions);

    return res.json({ success: true, data: { user: payload } });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ success: false, error: 'An error occurred during login.' });
  }
}

async function register(req, res) {
  const { email, password, name, phoneNumber, grade } = req.body;

  if (!email || typeof email !== 'string') return res.status(400).json({ success: false, error: 'Email is required.' });
  if (!password || typeof password !== 'string') return res.status(400).json({ success: false, error: 'Password is required.' });
  if (!name || typeof name !== 'string') return res.status(400).json({ success: false, error: 'Name is required.' });
  if (!phoneNumber) return res.status(400).json({ success: false, error: 'Phone number is required.' });
  if (!grade) return res.status(400).json({ success: false, error: 'Grade is required (FIRST_SECONDARY, SECOND_SECONDARY, or THIRD_SECONDARY).' });

  const allowedGrades = ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'];
  if (!allowedGrades.includes(grade)) {
    return res.status(400).json({ success: false, error: 'Invalid grade value. Must be one of: FIRST_SECONDARY, SECOND_SECONDARY, THIRD_SECONDARY.' });
  }

  try {
    const existingUser = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (existingUser) return res.status(409).json({ success: false, error: 'Email already registered.' });

    const existingPhone = await prisma.user.findUnique({ where: { phoneNumber: phoneNumber.trim() } });
    if (existingPhone) return res.status(409).json({ success: false, error: 'Phone number already registered.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await prisma.user.create({
      data: { name: name.trim(), email: email.trim().toLowerCase(), phoneNumber: phoneNumber.trim(), password: hashedPassword, grade }
    });

    const payload = { id: newUser.id, email: newUser.email, name: newUser.name, phoneNumber: newUser.phoneNumber, grade: newUser.grade, role: newUser.role };
    const token = createToken(payload, jwtConfig.secret);
    const refreshToken = createRefreshToken(payload, jwtConfig.refreshSecret);

    // Save refresh token in DB for revocation support
    await prisma.user.update({
      where: { id: newUser.id },
      data: { refreshToken }
    });

    // Set HttpOnly Cookies ONLY when there is no existing session. When an
    // already-authenticated caller registers (e.g. an admin adding a student),
    // setting these cookies would silently replace their session with the new
    // user's — hijacking the caller. Public signups (no session) still get
    // auto-login via cookies. `req.user` is populated by optionalAuth.
    if (!req.user) {
      res.cookie('accessToken', token, accessTokenCookieOptions);
      res.cookie('refreshToken', refreshToken, refreshTokenCookieOptions);
    }

    return res.status(201).json({ success: true, message: 'User registered successfully.', data: { user: payload } });
  } catch (error) {
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
        await prisma.user.update({
          where: { id: decoded.id },
          data: { refreshToken: null }
        });
      } catch (err) {
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
  const token = (req.cookies && req.cookies.refreshToken) || req.body.refreshToken;
  if (!token) return res.status(401).json({ success: false, error: 'Refresh token not provided.' });

  try {
    const decoded = jwt.verify(token, jwtConfig.refreshSecret);

    // Reject access tokens that were handed to the refresh endpoint
    if (decoded.type !== 'refresh') {
      return res.status(403).json({ success: false, error: 'Invalid or revoked refresh token.' });
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.id } });

    if (!user || user.refreshToken !== token) {
      return res.status(403).json({ success: false, error: 'Invalid or revoked refresh token.' });
    }

    const payload = { id: user.id, email: user.email, name: user.name, role: user.role };
    const newToken = createToken(payload, jwtConfig.secret);

    // ROTATE: issue a new refresh token, persist it, and re-set the cookie so a
    // replayed/reuse-detected token becomes invalid immediately.
    const newRefreshToken = createRefreshToken(payload, jwtConfig.refreshSecret);
    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: newRefreshToken }
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