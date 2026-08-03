require('dotenv').config();

// [C-3] Fail fast — refuse to start if critical secrets are missing
if (!process.env.JWTSECRET) {
  console.error('[FATAL] JWTSECRET environment variable is not set. Server will not start.');
  process.exit(1);
}

if (!process.env.ADMIN_PASSWORD) {
  console.error('[FATAL] ADMIN_PASSWORD environment variable is not set. Server will not start.');
  process.exit(1);
}

const config = {
  jwt: {
    secret: process.env.JWTSECRET,
    expiry: process.env.JWT_EXPIRY || '1h',
    refreshSecret: process.env.REFRESH_TOKEN_SECRET || process.env.JWTSECRET,
    refreshExpiry: process.env.REFRESH_TOKEN_EXPIRY || '7d'
  },
  admin: {
    // [C-2] Credentials come from env only — no hardcoded fallbacks
    email: process.env.ADMIN_EMAIL || 'admin@elearning.com',
    password: process.env.ADMIN_PASSWORD
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

module.exports = config;