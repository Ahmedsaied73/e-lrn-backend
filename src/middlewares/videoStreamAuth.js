const jwt = require('jsonwebtoken');
const path = require('path');
const { JWT_SECRET } = require('../config/env');

const generateVideoToken = (videoPath, expiresIn = '1h') => {
  return jwt.sign(
    { 
      videoPath,
      type: 'video-access'
    },
    JWT_SECRET,
    { expiresIn }
  );
};

const validateVideoToken = (req, res, next) => {
  try {
    const token = req.query.token;
    if (!token) {
      return res.status(401).json({ error: 'No access token provided' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'video-access') {
      return res.status(403).json({ error: 'Invalid token type' });
    }

    // Get the requested video path from the URL
    const requestedPath = decodeURIComponent(req.path)
      .replace(/^\/uploads\/videos\//, '')
      .split('/')
      .filter(Boolean)
      .join('/');

    // Get the authorized path from the token
    const authorizedPath = decoded.videoPath
      .replace(/^\/uploads\/videos\//, '')
      .split('/')
      .filter(Boolean)
      .join('/');

    // Check if the requested path matches or is a child of the authorized path
    if (!requestedPath.startsWith(authorizedPath)) {
      return res.status(403).json({ error: 'Access denied to this video file' });
    }

    req.videoToken = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Video access token has expired' });
    }
    return res.status(403).json({ error: 'Invalid video access token' });
  }
};

module.exports = {
  generateVideoToken,
  validateVideoToken
};