'use strict';

/**
 * cors.js — single source of truth for allowed browser origins.
 *
 * Shared by:
 *   - the CORS middleware in app.js (which origins may call the API),
 *   - the CSRF Origin-check middleware (a state-changing request from a
 *     browser with a cookie session must come from a known origin).
 *
 * Keep the two in lock-step: an origin allowed by CORS must also pass the
 * CSRF origin check, and vice versa. This module is the one place to edit.
 *
 * Origins:
 *   - Static list (localhost dev ports) + FRONTEND_URL (may be comma-separated:
 *     prod Vercel domain plus any PR/preview deployments).
 *   - Vercel preview deployments get their own fresh random subdomain per git
 *     push (https://<hash>.vercel.app), plus stable aliases — the wildcard
 *     keeps any branch/PR/preview origin working after the next deploy.
 *
 * Security posture:
 *   - THE WILDCARD IS THE ONLY NON-EXACT MATCH. Every non-Vercel origin must
 *     be listed exactly; a browser origin no one controls must not be honored.
 *   - Requests with NO Origin header at all are NOT cross-origin (curl, mobile
 *     apps, server-to-server) — the CSRF middleware requires an Origin before
 *     enforcing, so these are unaffected.
 */

const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3002',
  // FRONTEND_URL may be comma-separated: prod Vercel domain plus any PR/preview
  // deployments share the same cookie + JWT machinery without code changes.
  ...(process.env.FRONTEND_URL || '').split(',').map((s) => s.trim()).filter(Boolean),
].filter(Boolean);

// Vercel deploys a fresh random subdomain per git push (https://<hash>.vercel.app)
// plus stable aliases (prod, preview) — allow every *.vercel.app deployment so
// any branch/PR/preview origin works out-of-the-box after the next deploy.
const VERCEL_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;

function isAllowedOrigin(origin) {
  if (!origin || typeof origin !== 'string') return false;
  return allowedOrigins.includes(origin) || VERCEL_ORIGIN_RE.test(origin);
}

function getAllowedOrigins() {
  return allowedOrigins;
}

module.exports = { isAllowedOrigin, getAllowedOrigins };