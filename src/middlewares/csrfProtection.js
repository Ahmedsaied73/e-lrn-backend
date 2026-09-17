'use strict';

/**
 * csrfProtection.js — Origin/Referer CSRF verification for cookie sessions.
 *
 * WHY THIS DESIGN (no FE changes this round):
 *   The API authenticates via HttpOnly cookies (SameSite=None in production,
 *   since FE is cross-site on Vercel). A SameSite=None cookie makes the browser
 *   attach it to cross-site requests — including ones a malicious page triggers.
 *   A linking/CSRF token flow would need the FE to echo a header, which is a
 *   frontend change. The Origin-header check is the OWASP-sanctioned defence
 *   that needs no FE work:
 *
 *     A browser MUST send an `Origin` header on cross-origin requests and on
 *     same-origin POST. Therefore, any state-changing request whose Origin is
 *     present must come from an origin the app knows. If the Origin is absent
 *     (curl, server-to-server, script clients) the request is NOT from a
 *     browser context and cannot carry a victim's cookies cross-site — no CSRF
 *     vector exists, so it is allowed.
 *
 * ENFORCEMENT:
 *   - Applies to state-changing methods only (POST/PUT/PATCH/DELETE).
 *   - If an `Origin` header is present, it must pass isAllowedOrigin().
 *   - Otherwise, if a `Referer` is present, its origin must pass too (legacy
 *     clients that omit Origin but send Referer).
 *   - No Origin + no Referer → allow (non-browser client).
 *
 * SHARED ALLOWLIST: uses src/config/cors.js — the same list as the CORS
 * middleware, kept in lock-step so an origin CORS permits also passes here.
 */

const { isAllowedOrigin } = require('../config/cors');

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function originFromReferer(referer) {
  if (!referer || typeof referer !== 'string') return null;
  const m = referer.match(/^https?:\/\/[^/]+/i);
  return m ? m[0] : null;
}

function csrfProtection(req, res, next) {
  if (!STATE_CHANGING.has(req.method)) return next();

  const origin = req.headers.origin;
  if (origin) {
    if (isAllowedOrigin(origin)) return next();
    return res.status(403).json({
      success: false,
      error: 'Forbidden.',
      code: 'CSRF_DENIED_ORIGIN',
    });
  }

  const referer = originFromReferer(req.headers.referer);
  if (referer) {
    if (isAllowedOrigin(referer)) return next();
    return res.status(403).json({
      success: false,
      error: 'Forbidden.',
      code: 'CSRF_DENIED_ORIGIN',
    });
  }

  return next();
}

module.exports = csrfProtection;