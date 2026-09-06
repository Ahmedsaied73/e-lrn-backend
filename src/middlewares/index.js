const jwt = require('jsonwebtoken');
const { jwt: jwtConfig } = require('../config/env');
const logger = require('./logger');

/**
 * Authentication middleware.
 * Accepts token from Authorization Bearer header OR from the 'token' cookie.
 */
const authenticateToken = (req, res, next) => {
  // Check accessToken cookie first, then token cookie, then Authorization header as fallback
  const cookieToken = req.cookies && (req.cookies.accessToken || req.cookies.token);
  const authHeader = req.headers['authorization'];
  const headerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : (authHeader && authHeader.split(' ')[1]);

  const token = cookieToken || headerToken;

  if (!token) {
    return res.status(401).json({ success: false, error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, jwtConfig.secret);
    // Reject refresh tokens (and any token with a missing type claim) — only
    // 'access' tokens may authenticate API routes.
    if (decoded.type !== 'access') {
      return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
  }
};

/**
 * Optional authentication — resolves the current session when a valid access
 * token is present, but never rejects the request. Used on /auth/register so a
 * logged-in caller (e.g. an admin adding a student) keeps their own session
 * instead of having it overwritten by the newly-created user's cookies.
 */
const optionalAuth = (req, res, next) => {
  const cookieToken = req.cookies && (req.cookies.accessToken || req.cookies.token);
  const authHeader = req.headers['authorization'];
  const headerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : undefined;
  const token = cookieToken || headerToken;
  if (!token) return next();

  try {
    const decoded = jwt.verify(token, jwtConfig.secret);
    if (decoded.type === 'access') req.user = decoded;
  } catch (error) {
    // Invalid/expired token — ignore; the request proceeds unauthenticated.
  }
  return next();
};

/**
 * Role-based authorization middleware.
 * Supports both factory usage `authorizeAdmin(['ADMIN'])` or `authorizeAdmin()`
 * and direct middleware usage `router.post('/', authenticateToken, authorizeAdmin, handler)`.
 */
const authorizeAdmin = (arg1, arg2, arg3) => {
  // Direct middleware usage: authorizeAdmin(req, res, next)
  if (arg1 && arg2 && typeof arg3 === 'function') {
    const req = arg1;
    const res = arg2;
    const next = arg3;
    if (!req.user || !req.user.role) {
      return res.status(403).json({ success: false, error: 'Access denied. User not authenticated properly.' });
    }
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ success: false, error: 'Access denied. Insufficient privileges.' });
    }
    return next();
  }

  // Factory usage: authorizeAdmin(allowedRoles)
  const roles = Array.isArray(arg1) ? arg1 : ['ADMIN'];
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(403).json({ success: false, error: 'Access denied. User not authenticated properly.' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Access denied. Insufficient privileges.' });
    }
    next();
  };
};

// Access control middleware
const { checkCourseAccess, checkVideoAccess } = require('./accessControl');

module.exports = {
  authenticateToken,
  optionalAuth,
  authorizeAdmin,
  checkCourseAccess,
  checkVideoAccess,
  logger
};