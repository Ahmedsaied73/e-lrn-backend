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
  } catch {
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
  } catch {
    // Invalid/expired token — ignore; the request proceeds unauthenticated.
  }
  return next();
};

// ── In-process role cache (T1.3, TRAE-r2-hardening) ──────────────────────────
// The DB-backed role check below ran on EVERY admin request (a SELECT role per
// call). Under 2000 concurrent students + a busy admin console that burns pool
// capacity for no correctness gain: the access token already carries the role
// and expires in 15 min, so a demoted admin is at most 15 min stale from the
// token alone. A 5-minute in-process TTL cache bounds revocation freshness to
// 5 min (better than the token) while cutting admin-path DB reads ~100x.
//
// Single-process only by design (no Redis) — correct on default topology, and
// in multi-instance each API process carries its own tiny map, which is fine:
// the cache is a read accelerator for a value that changes only on admin
// grant/revoke. Use ROLECACHE_TTL_MS=0 to disable the cache entirely.
const ROLE_CACHE_TTL_MS = (() => {
  const raw = Number(process.env.ROLECACHE_TTL_MS);
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : 5 * 60 * 1000;
})();
const roleCache = new Map(); // userId -> { role, expiresAt }

function getCachedRole(userId) {
  if (ROLE_CACHE_TTL_MS === 0) return undefined;
  const entry = roleCache.get(userId);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    roleCache.delete(userId);
    return undefined;
  }
  return entry.role;
}

function cacheRole(userId, role) {
  if (ROLE_CACHE_TTL_MS === 0) return;
  roleCache.set(userId, { role, expiresAt: Date.now() + ROLE_CACHE_TTL_MS });
  // Bounded size: roles change rarely; a few thousand entries at ~100B each is
  // negligible, but cap defensively and drop all expired entries when full.
  if (roleCache.size > 5000) {
    const now = Date.now();
    for (const [id, entry] of roleCache) {
      if (now > entry.expiresAt) roleCache.delete(id);
    }
  }
}

// Cache invalidation point: call after an admin role is granted/revoked.
// (Granted via authController login/register setting the row; demotion via
// PUT /user/:id as ADMIN.) Exported for the few write sites that change role.
function invalidateRoleCache(userId) {
  if (userId) roleCache.delete(userId);
}

/**
 * Role-based authorization middleware. The JWT `role` claim is only a speed
 * bump — the actual role is re-verified against the DB on every call (5-min
 * in-process cache, see above), so a stale claim (e.g. after an admin demotes
 * a user, or a forged token replay) can never grant access for more than the
 * cache TTL. Supports both factory usage
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
      // DB check with in-process TTL cache: one SELECT per admin per 5 min,
      // not per request.
      const cachedRole = getCachedRole(req.user.id);
      const dbRole = cachedRole !== undefined
        ? cachedRole
        : (await prisma.user.findUnique({ where: { id: req.user.id }, select: { role: true } }))?.role || null;
      if (cachedRole === undefined) cacheRole(req.user.id, dbRole);
      if (!roles.includes(dbRole)) {
        return res.status(403).json({ success: false, error: 'Access denied. Insufficient privileges.' });
      }
      next();
    } catch {
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

/**
 * DB-verified admin check for student-path handlers. The JWT `role` claim is
 * only a speed bump — a stale claim (demoted admin, forged token) must not
 * grant the admin bypass on owner/enrollment-gated routes. Uses the same
 * 5-min in-process cache as authorizeAdmin. Cheap for the common path: tokens
 * that do NOT claim ADMIN skip the DB read entirely.
 * Returns the authoritative boolean, never throws.
 */
const isAdmin = async (req) => {
  if (!req.user || req.user.role !== 'ADMIN') return false;
  try {
    const cachedRole = getCachedRole(req.user.id);
    if (cachedRole !== undefined) return cachedRole === 'ADMIN';
    const dbUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { role: true },
    });
    const role = dbUser ? dbUser.role : null;
    cacheRole(req.user.id, role);
    return role === 'ADMIN';
  } catch {
    return false;
  }
};

module.exports = {
  authenticateToken,
  optionalAuth,
  authorizeAdmin,
  isAdmin,
  invalidateRoleCache,
  logger
};