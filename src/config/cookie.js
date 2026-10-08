const isProduction = process.env.NODE_ENV === 'production';

// SameSite rules depend on topology:
// - Dev (FE localhost:3000 → API localhost:3005) is same-site → 'lax' works.
// - Prod is CROSS-SITE: FE on Vercel (domain A) → API on Railway (domain B).
//   'strict' would silently prevent the browser from sending the session
//   cookie cross-site → every request 401s. 'none' + Secure is mandatory.
// - Override with COOKIE_SAMESITE if both are ever served same-site in prod.
const sameSite = process.env.COOKIE_SAMESITE || (isProduction ? 'none' : 'lax');

// Short-lived Access Token cookie options (15 Minutes)
const accessTokenCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite,
  maxAge: 15 * 60 * 1000,
  path: '/',
};

// Long-lived Refresh Token cookie options (7 Days)
const refreshTokenCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite,
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/auth',
};

// Long-lived Device Identifier cookie options (10 Years)
const deviceIdCookieOptions = {
  httpOnly: false, // Accessible to client-side JS to sync with localStorage
  secure: isProduction,
  sameSite,
  maxAge: 10 * 365 * 24 * 60 * 60 * 1000,
  path: '/',
};

module.exports = {
  accessTokenCookieOptions,
  refreshTokenCookieOptions,
  deviceIdCookieOptions,
};

