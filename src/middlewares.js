const jwt = require('jsonwebtoken');

// Authentication middleware
const authenticateToken = (req, res, next) => {
  // Check for token in cookies first
  const cookieToken = req.cookies.token;
  // Then check Authorization header as fallback
  const authHeader = req.headers['authorization'];
  const headerToken = authHeader && authHeader.split(' ')[1];
  
  // Use cookie token if available, otherwise use header token
  const token = cookieToken || headerToken;

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWTSECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token.' });
  }
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

module.exports = {
  authenticateToken,
  authorizeAdmin
};