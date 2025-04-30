require('dotenv').config();

// Debug: Check what we're loading from the environment
console.log('Environment loading debug:');
console.log('- YOUTUBE_API_KEY exists:', !!process.env.YOUTUBE_API_KEY);
console.log('- YOUTUBE_API_KEY type:', typeof process.env.YOUTUBE_API_KEY);
console.log('- YOUTUBE_API_KEY length:', process.env.YOUTUBE_API_KEY ? process.env.YOUTUBE_API_KEY.length : 0);

const config = {
  jwt: {
    secret: process.env.JWTSECRET || 'your_default_jwt_secret',
    expiry: process.env.JWT_EXPIRY || '1h',
    refreshSecret: process.env.REFRESH_TOKEN_SECRET || 'your_default_refresh_secret',
    refreshExpiry: process.env.REFRESH_TOKEN_EXPIRY || '7d'
  },
  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@elearning.com',
    password: process.env.ADMIN_PASSWORD || 'admin123'
  },
  email: {
    service: process.env.EMAIL_SERVICE,
    user: process.env.EMAIL_USER,
    password: process.env.EMAIL_PASS
  },
  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY
  }
};

// Debug: Check what we're exporting
console.log('Config apiKey exists:', !!config.youtube.apiKey);
console.log('Config apiKey type:', typeof config.youtube.apiKey);
console.log('Config apiKey length:', config.youtube.apiKey ? config.youtube.apiKey.length : 0);

module.exports = config; 