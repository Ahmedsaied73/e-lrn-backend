'use strict';

/**
 * sentry.js — backend-only error tracking (grilled decision G3).
 *
 * DSN-gated: no SENTRY_DSN in env → this module no-ops everywhere and
 * @sentry/node is never loaded (zero impost, zero vendor in dev/staging).
 * With a DSN → errors reach Sentry through never-throw wrappers: Sentry must
 * never take down the API it is supposed to be watching.
 *
 * Scope: only the backend captures. The frontend stays on PostHog.
 */

const config = require('./env');

const dsn = (config.sentry && config.sentry.dsn) || null;

let enabled = false;
let Sentry = null;

/**
 * Initialize @sentry/node. Call once, before routes. Safe to call multiple
 * times (idempotent). Never throws, never exits.
 * @returns {boolean} whether Sentry is active for this process.
 */
function initSentry() {
  if (enabled) return true;
  if (!dsn) {
    console.warn('[WARN] SENTRY_DSN not set — backend error tracking disabled (no-op).');
    return false;
  }
  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      // Keep the sample rate at 1.0 for errors (always capture) and lower the
      // transaction noise — this API has no per-page perf tracing need yet.
      tracesSampleRate: 0.0,
    });
    enabled = true;
    console.log('[INFO] Sentry initialized.');
  } catch (err) {
    // Never crash boot on a Sentry problem — error tracking is best-effort.
    console.warn('[WARN] Sentry init failed — continuing without error tracking:', err.message);
    enabled = false;
  }
  return enabled;
}

/**
 * Attach request context (path, method, userId) and capture an exception.
 * Never throws. No-ops when Sentry is disabled or init failed.
 * @param {Error} err
 * @param {import('express').Request} [req]
 */
function captureException(err, req) {
  if (!enabled || !Sentry) return;
  try {
    if (req) {
      Sentry.withScope((scope) => {
        scope.setTags({
          path: req.path || undefined,
          method: req.method || undefined,
        });
        if (req.user && req.user.id != null) {
          scope.setUser({ id: String(req.user.id) });
        }
        Sentry.captureException(err);
      });
      return;
    }
    Sentry.captureException(err);
  } catch (captureError) {
    // A Sentry failure must never mask the original error to the client.
    console.warn('[WARN] Sentry capture failed:', captureError.message);
  }
}

/**
 * Flush queued events before the process exits (crash handlers). Sentry's
 * transport buffers and flushes on an interval; process.exit(1) right after
 * capture would drop the just-captured crash. Wait up to `timeoutMs` for the
 * payload to leave. Never throws.
 * @param {number} [timeoutMs]
 */
async function flush(timeoutMs = 2000) {
  if (!enabled || !Sentry) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch (err) {
    console.warn('[WARN] Sentry flush failed:', err.message);
  }
}

module.exports = { initSentry, captureException, flush, isEnabled: () => enabled };