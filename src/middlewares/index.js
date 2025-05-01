const jwt = require('jsonwebtoken');
const logger = require('./logger');

// Authentication middleware
const authenticateToken = (req, res, next) => {
  // Get token from Authorization header
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }
  
  jwt.verify(token, process.env.JWTSECRET, (err, user) => {
    if (err) {
      return res.status(401).json({ error: 'Invalid token.' });
    }
    
    req.user = user;
    next();
  });
};

// Admin authorization middleware
const authorizeAdmin = (allowedRoles) => {
  // If no roles specified, default to only ADMIN role
  const roles = Array.isArray(allowedRoles) ? allowedRoles : ['ADMIN'];
  
  return (req, res, next) => {
    // Check if user exists and has a role
    if (!req.user || !req.user.role) {
      return res.status(403).json({ error: 'Access denied. User not authenticated properly.' });
    }
    
    // Check if user's role is in the allowed roles
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied. Insufficient privileges.' });
    }
    
    next();
  };
};

// Import access control middleware
const { checkCourseAccess, checkVideoAccess } = require('./accessControl');

module.exports = {
  authenticateToken,
  authorizeAdmin,
  checkCourseAccess,
  checkVideoAccess,
  logger
};