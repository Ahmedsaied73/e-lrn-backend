'use strict';

/**
 * Bunny Webhook Controller
 *
 * Handles POST /webhooks/bunny/stream — the Bunny Stream status callback.
 *
 * CRITICAL SECURITY REQUIREMENTS:
 * 1. Raw body must be read BEFORE express.json() parses it — the route must
 *    use express.raw() middleware, mounted BEFORE global express.json() in app.js.
 * 2. HMAC-SHA256 signature must be verified with constant-time comparison
 *    BEFORE the body is parsed as JSON.
 * 3. Version and algorithm headers must both be pinned — reject anything unexpected.
 * 4. The handler must respond 200 quickly — Bunny may retry on non-200 responses.
 *    Never block webhook processing on slow operations.
 *
 * This is an internal provider callback — not a public user-facing API.
 * No authentication token required (or useful) — HMAC is the only auth mechanism.
 */

const bunnyClient = require('../integrations/bunny/bunnyStreamClient');
const bunnyVideoService = require('../services/bunnyVideoService');

const log = {
  info: (event, ctx = {}) => console.log(`[INFO] ${event}`, JSON.stringify(ctx)),
  warn: (event, ctx = {}) => console.warn(`[WARN] ${event}`, JSON.stringify(ctx)),
  error: (event, ctx = {}) => console.error(`[ERROR] ${event}`, JSON.stringify(ctx)),
};

/**
 * POST /webhooks/bunny/stream
 *
 * Bunny sends this when a video's encoding status changes.
 * Expected headers:
 *   X-BunnyStream-Signature: <hmac-sha256-hex>
 *   X-BunnyStream-Signature-Version: v1
 *   X-BunnyStream-Signature-Algorithm: hmac-sha256
 *
 * Expected payload shape:
 *   { VideoGuid: string, Status: number, ... }
 *
 * @param {import('express').Request} req - req.body is a Buffer (express.raw middleware)
 * @param {import('express').Response} res
 */
const handleBunnyWebhook = async (req, res) => {
  // req.body is a Buffer here — express.raw() was applied to this route only
  const rawBody = req.body instanceof Buffer
    ? req.body.toString('utf8')
    : String(req.body);

  // ── Step 1: Verify signature BEFORE parsing body ─────────────────────────
  const isValid = bunnyClient.verifyWebhookSignature({
    rawBody,
    signature: req.headers['x-bunnystream-signature'],
    version: req.headers['x-bunnystream-signature-version'],
    algorithm: req.headers['x-bunnystream-signature-algorithm'],
  });

  if (!isValid) {
    log.warn('bunny.webhook.rejected', {
      reason: 'invalid_signature',
      version: req.headers['x-bunnystream-signature-version'],
      algorithm: req.headers['x-bunnystream-signature-algorithm'],
      hasSignature: !!req.headers['x-bunnystream-signature'],
      ip: req.ip,
    });
    // Return 401 — do NOT reveal why validation failed (timing/oracle prevention)
    return res.status(401).send();
  }

  // ── Step 2: Parse JSON body ───────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    log.warn('bunny.webhook.rejected', { reason: 'malformed_json' });
    return res.status(400).send();
  }

  // ── Step 3: Validate payload shape ────────────────────────────────────────
  if (!payload.VideoGuid || typeof payload.VideoGuid !== 'string') {
    log.warn('bunny.webhook.rejected', { reason: 'missing_video_guid' });
    return res.status(400).send();
  }

  if (typeof payload.Status !== 'number') {
    log.warn('bunny.webhook.rejected', { reason: 'missing_or_invalid_status' });
    return res.status(400).send();
  }

  log.info('bunny.webhook.received', {
    bunnyVideoId: payload.VideoGuid,
    status: payload.Status,
  });

  // ── Step 4: Apply status update (idempotent) ──────────────────────────────
  // applyBunnyStatus handles unknown videos, terminal-state idempotency,
  // and ignored status codes (6-10) gracefully.
  try {
    await bunnyVideoService.applyBunnyStatus(payload.VideoGuid, payload.Status);
  } catch (err) {
    // Log error but still return 200 to Bunny — we don't want Bunny to retry
    // indefinitely for errors that are our internal issue (e.g. DB transient).
    // The reconciliation job will catch and repair any missed status transitions.
    log.error('bunny.webhook.processing_error', {
      bunnyVideoId: payload.VideoGuid,
      status: payload.Status,
      error: err.message,
    });
  }

  // ── Step 5: Respond 200 quickly ───────────────────────────────────────────
  return res.status(200).send();
};

module.exports = { handleBunnyWebhook };
