'use strict';

/**
 * Application Error Class
 *
 * Lightweight, structured error for Bunny video feature routes.
 * Carries an HTTP status code and a stable machine-readable code string
 * so clients can programmatically distinguish error types.
 *
 * Usage in controllers/services:
 *   throw new AppError('Video not found', 404, 'VIDEO_NOT_FOUND');
 *
 * The global error handler in app.js catches these and formats them
 * using the existing response envelope: { success: false, error, code }
 */
class AppError extends Error {
  /**
   * @param {string} message - Human-readable error message (returned to client)
   * @param {number} statusCode - HTTP status code (404, 403, 422, 500, etc.)
   * @param {string} code - Machine-readable error code (see constants below)
   */
  constructor(message, statusCode, code) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

// ─── Error Code Constants ─────────────────────────────────────────────────────
// Stable string codes — safe to return in API responses, safe to log.
// Never include Bunny secrets, JWTs, or infra details in messages.

const ErrorCodes = {
  // Video resource errors
  VIDEO_NOT_FOUND: 'VIDEO_NOT_FOUND',
  COURSE_NOT_FOUND: 'COURSE_NOT_FOUND',

  // Authorization errors
  VIDEO_ACCESS_DENIED: 'VIDEO_ACCESS_DENIED',
  COURSE_ACCESS_DENIED: 'COURSE_ACCESS_DENIED',

  // State machine errors
  VIDEO_NOT_READY: 'VIDEO_NOT_READY',
  INVALID_VIDEO_STATE: 'INVALID_VIDEO_STATE',

  // Upload errors
  VIDEO_UPLOAD_FAILED: 'VIDEO_UPLOAD_FAILED',
  INVALID_VIDEO_FILE: 'INVALID_VIDEO_FILE',
  VIDEO_TOO_LARGE: 'VIDEO_TOO_LARGE',

  // Bunny integration errors
  BUNNY_API_ERROR: 'BUNNY_API_ERROR',
  BUNNY_WEBHOOK_INVALID_SIGNATURE: 'BUNNY_WEBHOOK_INVALID_SIGNATURE',
};

module.exports = { AppError, ErrorCodes };
