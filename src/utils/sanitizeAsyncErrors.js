'use strict';

/**
 * Express 4 async-rejection sanitization.
 *
 * Express 4 (unlike 5) does NOT catch rejected promises from async middleware
 * or handlers — a throw inside `async (req, res) => {}` becomes an
 * UNHANDLED rejection. This app's process-level handler treats unhandled
 * rejections as FATAL (process.exit(1), see app.js), so one bad async route
 * would take the whole API down.
 *
 * This module patches Express's internal `Layer.prototype.handle_request` to
 * detect a returned promise and route its rejection to `next(err)` — exactly
 * like Express 5 / `express-async-errors`, but self-contained (no extra dep).
 * The global error handler then returns the sanitized `{ success:false }`
 * 500 envelope; raw error objects never reach the client.
 *
 * Install ONCE at boot, before any route is mounted:
 *   require('./src/utils/sanitizeAsyncErrors');
 *
 * Notes:
 * - Only patches functions whose return value is a thenable, so synchronous
 *   handlers (the common case) are completely untouched.
 * - Middleware expecting 4 args (`(err, req, res, next)`) is preserved
 *   untouched (listener.length > 3 → bypass).
 * - A rejection with a falsy reason (e.g. `throw undefined`) is normalized to
 *   a real Error so `next(reason)` never silently walks PAST the error router.
 */

const Layer = require('express/lib/router/layer');

const originalHandleRequest = Layer.prototype.handle_request;

Layer.prototype.handle_request = function handleRequest(req, res, next) {
  const fn = this.handle;

  // Error-handling middleware — takes (err, req, res, next). Never patch.
  if (fn.length > 3) {
    return next();
  }

  try {
    const result = fn(req, res, next);
    if (result && typeof result.then === 'function') {
      result.then(null, (reason) => {
        if (!reason) reason = new Error('Async handler rejected with no reason');
        next(reason);
      });
    }
  } catch (err) {
    next(err);
  }
};

// Keep the original around for anyone (tests, debugging) who needs the
// pristine implementation. Not used by the running app.
Layer.prototype.__original_handle_request = originalHandleRequest;

module.exports = { patched: true };