'use strict';

/**
 * Bunny Stream API Client
 *
 * Isolation rule: ALL Bunny HTTP calls go through this module.
 * No raw fetch() or https.request() to video.bunnycdn.com anywhere else in the app.
 *
 * Uses Node global `fetch` (Node >=18) for JSON calls.
 * Uses `https.request` for the streamed binary PUT — piping a body through
 * fetch's duplex mode is less predictable across Node versions, so native
 * https is the safer pick for large streaming uploads.
 */

const https = require('https');
const crypto = require('crypto');

const BUNNY_HOST = 'video.bunnycdn.com';

// Hung metadata calls must not pin request handlers (Node fetch has no
// timeout otherwise). The binary upload stream is *inactivity*-timed below
// (BUNNY_UPLOAD_INACTIVITY_TIMEOUT_MS) — slow-but-flowing uploads survive;
// only a socket that stops moving bytes gets killed.
const BUNNY_API_TIMEOUT_MS = 20000;
// Upload paths: timeout on *inactivity* only, not total wall-clock. A multi-GB
// upload over a slow uplink can legitimately run for minutes — what must die is
// a socket that stops flowing (hung Bunny, stalled pipe). `req.setTimeout`
// arms the socket's idle timer, which Node resets on any socket activity, so
// data still moving keeps the upload alive.
const BUNNY_UPLOAD_INACTIVITY_TIMEOUT_MS = 30 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Read library ID lazily so it's always current from env (set after require). */
const libId = () => process.env.BUNNY_STREAM_LIBRARY_ID;

/** Shared headers for authenticated Bunny API calls. */
const authHeaders = () => ({
  AccessKey: process.env.BUNNY_STREAM_API_KEY,
  Accept: 'application/json',
  'Content-Type': 'application/json',
});

// ─── Error class ─────────────────────────────────────────────────────────────

// Bunny error bodies can be large and full of internal identifiers. Capping
// what lands in `message` (which flows into logs, DB failureReason columns,
// and any surfaced AppError) keeps Bunny internals out of operator/student
// surfaces while still being useful. The full body stays on `this.body` for
// any server-side consumer that needs it.
const BUNNY_ERROR_BODY_MAX_CHARS = 500;

/**
 * Represents an error response from the Bunny API.
 * Carries the HTTP status code and raw response body for logging/compensation.
 */
class BunnyApiError extends Error {
  constructor(statusCode, body) {
    const safeBody = typeof body === 'string' && body.length > BUNNY_ERROR_BODY_MAX_CHARS
      ? `${body.slice(0, BUNNY_ERROR_BODY_MAX_CHARS)}… (truncated)`
      : body;
    super(`Bunny API error ${statusCode}: ${safeBody}`);
    this.name = 'BunnyApiError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

/**
 * Thrown when the Bunny circuit is OPEN and the caller cannot proceed.
 * Surfaces as HTTP 503 at the global error handler.
 */
class BunnyCircuitOpenError extends Error {
  constructor() {
    super('Bunny Stream API is temporarily unavailable (circuit open). Retry shortly.');
    this.name = 'BunnyCircuitOpenError';
    this.statusCode = 503;
  }
}

// ─── Circuit breaker ─────────────────────────────────────────────────────────
//
// State machine: CLOSED → (threshold 5xx/network failures) → OPEN
//                OPEN   → (cooldown elapsed)             → HALF_OPEN
//                HALF_OPEN → (single probe succeeds)     → CLOSED
//                           (probe fails)                → OPEN
//
// Fail-open for reads (getVideo): when OPEN, return last-known-good metadata
// so reconciliation/playback flows are non-fatal during a Bunny outage.
// Fail-fast for writes (create/delete/upload): when OPEN, throw immediately
// instead of waiting for timeouts that would just fail.

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30000;

const circuit = {
  state: 'CLOSED',          // CLOSED | OPEN | HALF_OPEN
  consecutiveFailures: 0,
  openedAt: 0,
  probeInFlight: false,
  /** @type {Map<string, { data: object, at: number }>} last successful getVideo per bunnyVideoId */
  lastKnownGood: new Map(),
};

function checkCircuit() {
  if (circuit.state === 'OPEN') {
    if (circuit.probeInFlight) {
      return 'CIRCUIT_OPEN';
    }
    if (Date.now() - circuit.openedAt >= CIRCUIT_COOLDOWN_MS) {
      circuit.state = 'HALF_OPEN';
      // fall through — one probe allowed
    } else {
      return 'CIRCUIT_OPEN';
    }
  }
  if (circuit.state === 'HALF_OPEN') {
    if (circuit.probeInFlight) return 'CIRCUIT_OPEN';
    circuit.probeInFlight = true;
    return 'HALF_OPEN_PROBE';
  }
  // CLOSED
  return 'CLOSED';
}

/** Mark a call as successful (reset failures; close circuit if probe passed). */
function circuitSuccess() {
  circuit.consecutiveFailures = 0;
  if (circuit.state === 'HALF_OPEN') {
    circuit.state = 'CLOSED';
    circuit.probeInFlight = false;
  }
}

/**
 * Mark a call as a failure toward the circuit (5xx / timeout / network error).
 * 4xx are NOT circuit failures — they're client errors, not Bunny outages.
 */
function circuitFailure(err, statusCode) {
  const isFailure =
    (statusCode >= 500 && statusCode < 600) ||
    (err && (
      err.name === 'TimeoutError' ||
      err.name === 'AbortError' ||
      err.code === 'ECONNRESET' ||
      err.code === 'ECONNREFUSED' ||
      err.code === 'EPIPE' ||
      err.code === 'UND_ERR_SOCKET' ||
      err.code === 'BUNNY_UPLOAD_STALLED'
    ));

  if (!isFailure) return; // 4xx / unknown → don't count

  circuit.consecutiveFailures += 1;
  if (circuit.state === 'HALF_OPEN' || circuit.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuit.state = 'OPEN';
    circuit.openedAt = Date.now();
  }
  circuit.probeInFlight = false;
}

/**
 * Generic gate wrapper. `fn` must return the promise. `failOpenFallback` is
 * called instead of throwing when the circuit is OPEN and available (only
 * used by getVideo to return cached metadata). If fallback is null/undefined
 * the circuit-open error is thrown.
 */
async function gateCall(fn, failOpenFallback) {
  const gate = checkCircuit();
  if (gate === 'CIRCUIT_OPEN') {
    if (typeof failOpenFallback === 'function') return failOpenFallback();
    throw new BunnyCircuitOpenError();
  }
  try {
    const result = await fn();
    circuitSuccess();
    return result;
  } catch (err) {
    // Circuit tracking for the raw HTTP layer: pass the status code
    // from BunnyApiError (if present) to circuitFailure for 5xx detection.
    circuitFailure(err, err instanceof BunnyApiError ? err.statusCode : undefined);
    throw err;
  }
}

// ─── Video CRUD ───────────────────────────────────────────────────────────────

/**
 * Create a new video object in Bunny's library.
 * Must be called before uploading — Bunny requires a video object to exist first.
 * Trips the circuit breaker on 5xx/network errors.
 *
 * @param {object} params
 * @param {string} params.title - Video title
 * @param {string} [params.collectionId] - Optional Bunny collection ID
 * @returns {Promise<object>} Bunny video object (contains .guid used as bunnyVideoId)
 */
async function createVideo({ title, collectionId }) {
  return gateCall(async () => {
    const url = `https://${BUNNY_HOST}/library/${libId()}/videos`;
    const body = { title };
    if (collectionId) body.collectionId = collectionId;

    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      // Hung metadata calls must not pin handlers: the upload stream itself
      // stays untimed (multi-GB uploads are legitimately slow).
      signal: AbortSignal.timeout(BUNNY_API_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new BunnyApiError(res.status, await res.text());
    }

    return res.json(); // { guid, videoLibraryId, title, ... }
  });
}

/**
 * Fetch metadata for an existing Bunny video.
 * Used by the reconciliation job to poll encoding status.
 * Fail-open: when the circuit is OPEN, serves last-known-good metadata (with
 * a `_stale` flag) so reads never fail fully during a Bunny outage. Writes
 * trip; reads degrade.
 *
 * @param {string} bunnyVideoId - The Bunny video GUID
 * @returns {Promise<object>} Bunny video metadata (contains .status, .duration, etc.)
 */
async function getVideo(bunnyVideoId) {
  return gateCall(
    async () => {
      const url = `https://${BUNNY_HOST}/library/${libId()}/videos/${bunnyVideoId}`;

      const res = await fetch(url, {
        headers: {
          AccessKey: process.env.BUNNY_STREAM_API_KEY,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(BUNNY_API_TIMEOUT_MS),
      });

      if (!res.ok) {
        throw new BunnyApiError(res.status, await res.text());
      }

      const data = await res.json();
      // Cache the latest successful metadata for fail-open reads. Bound the
      // map to the reconciliation job's worked set (only PROCESSING/READY
      // videos are ever polled); evict by FIFO when the cap is hit.
      if (circuit.lastKnownGood.size >= 10000) {
        const oldestKey = circuit.lastKnownGood.keys().next().value;
        circuit.lastKnownGood.delete(oldestKey);
      }
      circuit.lastKnownGood.set(bunnyVideoId, { data, at: Date.now() });
      return data;
    },
    () => {
      // OPEN fallback: serve cached metadata with a stale marker. Callers
      // (reconciliation) treat stale data non-destructively — see
      // reconcileStaleVideos's re-check on next tick.
      const cached = circuit.lastKnownGood.get(bunnyVideoId);
      if (cached) return { ...cached.data, _stale: true, _cachedAt: cached.at };
      throw new BunnyCircuitOpenError();
    }
  );
}

/**
 * Delete a Bunny video object.
 * Called as compensation when a DB insert fails after a successful Bunny create.
 * Trips the circuit breaker on 5xx/network errors (404 is NOT a trip — it's a
 * benign "already gone").
 *
 * @param {string} bunnyVideoId - The Bunny video GUID
 * @returns {Promise<void>}
 */
async function deleteVideo(bunnyVideoId) {
  return gateCall(async () => {
    const url = `https://${BUNNY_HOST}/library/${libId()}/videos/${bunnyVideoId}`;

    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        AccessKey: process.env.BUNNY_STREAM_API_KEY,
      },
      signal: AbortSignal.timeout(BUNNY_API_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new BunnyApiError(res.status, await res.text());
    }
  });
}

// ─── Upload ───────────────────────────────────────────────────────────────────

/**
 * Stream a file binary directly to Bunny via HTTP PUT.
 *
 * Key design decisions:
 * - Uses `https.request` (not fetch) to pipe the incoming stream without buffering.
 * - The `fileStream` is piped directly into the outgoing request body.
 * - On client disconnect or stream error, the outgoing request is destroyed.
 * - No base64, no temp files, no memory accumulation.
 *
 * @param {object} params
 * @param {string} params.bunnyVideoId - The Bunny video GUID to upload to
 * @param {import('stream').Readable} params.fileStream - Readable stream of the file binary
 * @returns {Promise<object>} Bunny upload response body
 */
function uploadVideoStream({ bunnyVideoId, fileStream }) {
  return gateCall(async () => new Promise((resolve, reject) => {
    // Guard: once the promise settles (success or error), the watchdog must
    // no-op.  Without this, a timer armed on a keep-alive socket could fire
    // after the upload completes, calling req.destroy() on a pooled socket
    // that another request may have started using.
    let settled = false;

    const req = https.request(
      {
        hostname: BUNNY_HOST,
        path: `/library/${libId()}/videos/${bunnyVideoId}`,
        method: 'PUT',
        headers: {
          AccessKey: process.env.BUNNY_STREAM_API_KEY,
          'Content-Type': 'application/octet-stream',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              if (!settled) { settled = true; resolve(JSON.parse(body)); }
            } catch {
              if (!settled) { settled = true; resolve({ success: true }); }
            }
          } else {
            if (!settled) { settled = true; reject(new BunnyApiError(res.statusCode, body)); }
          }
        });
      }
    );

    req.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });

    // Inactivity watchdog (F2/S3): if NO bytes flow through the socket for
    // BUNNY_UPLOAD_INACTIVITY_TIMEOUT_MS the upload is hung — kill it. Node's
    // socket idle timer resets on every activity, so a slow-but-flowing
    // multi-GB upload is never affected.
    req.setTimeout(BUNNY_UPLOAD_INACTIVITY_TIMEOUT_MS, () => {
      if (settled) return; // upload already succeeded/failed — idle timer is on a pooled socket
      const err = new Error(
        `Bunny upload stalled — no data for ${Math.round(BUNNY_UPLOAD_INACTIVITY_TIMEOUT_MS / 1000)}s`
      );
      // Tag for the circuit breaker: a stall is an outage signal, not a
      // sample failure.
      err.code = 'BUNNY_UPLOAD_STALLED';
      settled = true;
      fileStream.unpipe(req);
      req.destroy(err);
      reject(err);
    });

    // If the incoming file stream errors (e.g. client disconnected),
    // destroy the outgoing Bunny request and propagate the error.
    fileStream.on('error', (err) => {
      if (!settled) { settled = true; req.destroy(); reject(err); }
    });

    fileStream.pipe(req);
  }));
}

// ─── Token Auth ───────────────────────────────────────────────────────────────

/**
 * Generate a signed playback token for Bunny Embed Token Authentication.
 *
 * Algorithm (per Bunny docs): SHA256(tokenKey + videoId + expires)
 * The token + expires are appended as query params to the embed URL.
 *
 * Security: Never log or return BUNNY_STREAM_TOKEN_KEY.
 * The token itself is safe to return — it's time-limited and video-scoped.
 *
 * @param {string} bunnyVideoId - The Bunny video GUID
 * @param {number} [ttlSeconds] - Token validity period in seconds (default 6 hours / 21600s)
 * @returns {{ token: string, expiresAt: number }} Hex token and Unix expiry timestamp
 */
function generatePlaybackToken(bunnyVideoId, ttlSeconds) {
  const defaultTtl = Number(process.env.BUNNY_STREAM_TOKEN_TTL_SECONDS) || 21600; // 6 hours
  const ttl = ttlSeconds || defaultTtl;
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;

  const token = crypto
    .createHash('sha256')
    .update(process.env.BUNNY_STREAM_TOKEN_KEY + bunnyVideoId + expiresAt)
    .digest('hex');

  return { token, expiresAt };
}

// ─── Webhook Verification ─────────────────────────────────────────────────────

/**
 * Verify a Bunny webhook signature using HMAC-SHA256.
 *
 * Per Bunny's current webhook docs:
 * - Signing secret IS the library's Read-Only API key (not a separate secret)
 * - Signature header: X-BunnyStream-Signature
 * - Version header: X-BunnyStream-Signature-Version (must be 'v1')
 * - Algorithm header: X-BunnyStream-Signature-Algorithm (must be 'hmac-sha256')
 *
 * CRITICAL: rawBody must be the raw Buffer/string BEFORE any JSON.parse.
 * Uses crypto.timingSafeEqual to prevent timing attacks.
 *
 * @param {object} params
 * @param {string} params.rawBody - Raw request body as UTF-8 string
 * @param {string} params.signature - Value of X-BunnyStream-Signature header
 * @param {string} params.version - Value of X-BunnyStream-Signature-Version header
 * @param {string} params.algorithm - Value of X-BunnyStream-Signature-Algorithm header
 * @returns {boolean} true if signature is valid
 */
function verifyWebhookSignature({ rawBody, signature, version, algorithm }) {
  // Pin version and algorithm — reject anything unexpected
  if (version !== 'v1' || algorithm !== 'hmac-sha256') {
    return false;
  }

  if (!signature || typeof signature !== 'string') {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', process.env.BUNNY_STREAM_READ_ONLY_API_KEY)
    .update(rawBody, 'utf8')
    .digest('hex');

  // Length check before timingSafeEqual to avoid Buffer size mismatch error
  if (signature.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(signature, 'utf8')
  );
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  createVideo,
  getVideo,
  deleteVideo,
  uploadVideoStream,
  generatePlaybackToken,
  verifyWebhookSignature,
  BunnyApiError,
  BunnyCircuitOpenError,
};
