const jwt = require('jsonwebtoken');
const { jwt: jwtConfig } = require('../config/env');
const prisma = require('../config/db');
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
 * Role-based authorization middleware. The JWT `role` claim is only a speed
 * bump — the actual role is re-verified against the DB on every call, so a
 * stale claim (e.g. after an admin demotes a user, or a forged token replay)
 * can never grant access. Supports both factory usage
 * `authorizeAdmin(['ADMIN'])` / `authorizeAdmin()` and direct middleware usage
 * `router.post('/', authenticateToken, authorizeAdmin, handler)`.
 */
const authorizeAdmin = (arg1, arg2, arg3) => {
  const enforce = async (req, res, next, roles) => {
    try {
      if (!req.user || !req.user.id) {
        return res.status(403).json({ success: false, error: 'Access denied. User not authenticated properly.' });
      }
      // Claim check first (cheap reject), then authoritative DB check.
      if (!roles.includes(req.user.role)) {
        return res.status(403).json({ success: false, error: 'Access denied. Insufficient privileges.' });
      }
      const dbUser = await prisma.user.findUnique({ where: { id: req.user.id }, select: { role: true } });
      if (!dbUser || !roles.includes(dbUser.role)) {
        return res.status(403).json({ success: false, error: 'Access denied. Insufficient privileges.' });
      }
      next();
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to verify authorization.' });
    }
  };

  // Direct middleware usage: authorizeAdmin(req, res, next)
  if (arg1 && arg2 && typeof arg3 === 'function') {
    return enforce(arg1, arg2, arg3, ['ADMIN']);
  }

  // Factory usage: authorizeAdmin(allowedRoles)
  const roles = Array.isArray(arg1) ? arg1 : ['ADMIN'];
  return (req, res, next) => enforce(req, res, next, roles);
};

module.exports = {
  authenticateToken,
  optionalAuth,
  authorizeAdmin,
  logger
};