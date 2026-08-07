const isProduction = process.env.NODE_ENV === 'production';

// Short-lived Access Token cookie options (15 Minutes)
const accessTokenCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? 'strict' : 'lax',
  maxAge: 15 * 60 * 1000,
  path: '/',
};

// Long-lived Refresh Token cookie options (7 Days)
const refreshTokenCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? 'strict' : 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/auth',
};

module.exports = {
  accessTokenCookieOptions,
  refreshTokenCookieOptions,
};
