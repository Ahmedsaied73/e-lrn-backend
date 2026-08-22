const jwt = require('jsonwebtoken');
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
    const decoded = jwt.verify(token, process.env.JWTSECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
  }
};

/**
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
  authorizeAdmin,
  checkCourseAccess,
  checkVideoAccess,
  logger
};