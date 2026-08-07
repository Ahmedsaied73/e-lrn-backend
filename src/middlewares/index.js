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
 * Role-based authorization middleware factory.
 * @param {string|string[]} allowedRoles - Roles permitted to access the route. Defaults to ['ADMIN'].
 */
const authorizeAdmin = (allowedRoles) => {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : ['ADMIN'];

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