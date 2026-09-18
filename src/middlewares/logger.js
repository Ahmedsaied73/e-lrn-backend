/**
 * Request Logger Middleware (structured)
 *
 * Emits one JSON object per request/response so logs are machine-parseable
 * (matching the structured `[INFO] module.event {...}` convention used by the
 * jobs and workers) instead of free-text lines.
 *
 * Features:
 * - Single `[RESPONSE] {...}` JSON line per completed request: method, path,
 *   status, response time, client IP, userId, optional requestId.
 * - Optional request-time headers/body capture (off by default; sensitive
 *   fields are ALWAYS masked even when explicitly enabled).
 * - Error responses emit a `[ERROR]` line with the same masked payload.
 * - `/health` and `/metrics` are excluded so probes stay quiet.
 */

const logger = (options = {}) => {
  const config = {
    logHeaders: options.logHeaders || false,
    logBody: options.logBody || false,
    sensitiveFields: options.sensitiveFields || ['password', 'token', 'authorization', 'cookie'],
    excludePaths: options.excludePaths || ['/health', '/metrics'],
  };

  /**
   * Deep-copy and mask sensitive keys. Never mutates the input object.
   */
  const maskSensitiveData = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(maskSensitiveData);

    const masked = {};
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (config.sensitiveFields.includes(key.toLowerCase())) {
        masked[key] = '[REDACTED]';
      } else if (value && typeof value === 'object') {
        masked[key] = maskSensitiveData(value);
      } else {
        masked[key] = value;
      }
    }
    return masked;
  };

  return (req, res, next) => {
    if (config.excludePaths.some((p) => req.path.startsWith(p))) {
      return next();
    }

    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    const base = {
      timestamp,
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip || req.connection.remoteAddress,
      userId: req.user ? req.user.id : null,
      requestId: req.headers['x-request-id'] || null,
    };

    if (config.logHeaders) {
      base.requestHeaders = maskSensitiveData(req.headers);
    }
    if (config.logBody && req.body && Object.keys(req.body).length > 0) {
      base.requestBody = maskSensitiveData(req.body);
    }

    res.on('finish', () => {
      const entry = {
        ...base,
        status: res.statusCode,
        durationMs: Date.now() - startTime,
      };

      try { require('../metrics/metrics').recordRequest(res.statusCode, entry.durationMs); } catch { /* metrics never break requests */ }

      // The enriched object stays private to this handler; on error we log the
      // same masked payload (never the raw request body/headers).
      const logLine = JSON.stringify(entry);
      if (res.statusCode >= 400) {
        console.error(`[ERROR] ${logLine}`);
      } else {
        console.log(`[RESPONSE] ${logLine}`);
      }
    });

    next();
  };
};

module.exports = logger;