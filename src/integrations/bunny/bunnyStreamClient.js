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

// ─── Video CRUD ───────────────────────────────────────────────────────────────

/**
 * Create a new video object in Bunny's library.
 * Must be called before uploading — Bunny requires a video object to exist first.
 *
 * @param {object} params
 * @param {string} params.title - Video title
 * @param {string} [params.collectionId] - Optional Bunny collection ID
 * @returns {Promise<object>} Bunny video object (contains .guid used as bunnyVideoId)
 */
async function createVideo({ title, collectionId }) {
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
}

/**
 * Fetch metadata for an existing Bunny video.
 * Used by the reconciliation job to poll encoding status.
 *
 * @param {string} bunnyVideoId - The Bunny video GUID
 * @returns {Promise<object>} Bunny video metadata (contains .status, .duration, etc.)
 */
async function getVideo(bunnyVideoId) {
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

  return res.json();
}

/**
 * Delete a Bunny video object.
 * Called as compensation when a DB insert fails after a successful Bunny create.
 *
 * @param {string} bunnyVideoId - The Bunny video GUID
 * @returns {Promise<void>}
 */
async function deleteVideo(bunnyVideoId) {
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
  return new Promise((resolve, reject) => {
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
              resolve(JSON.parse(body));
            } catch {
              resolve({ success: true }); // Bunny may return empty body on success
            }
          } else {
            reject(new BunnyApiError(res.statusCode, body));
          }
        });
      }
    );

    req.on('error', (err) => {
      reject(err);
    });

    // Inactivity watchdog (F2/S3): if NO bytes flow through the socket for
    // BUNNY_UPLOAD_INACTIVITY_TIMEOUT_MS the upload is hung — kill it. Node's
    // socket idle timer resets on every activity, so a slow-but-flowing
    // multi-GB upload is never affected.
    req.setTimeout(BUNNY_UPLOAD_INACTIVITY_TIMEOUT_MS, () => {
      const err = new Error(
        `Bunny upload stalled — no data for ${Math.round(BUNNY_UPLOAD_INACTIVITY_TIMEOUT_MS / 1000)}s`
      );
      // Stop feeding Bunny and reject. req.destroy() also triggers req 'error'
      // downstream, but reject() here is idempotent — the promise settles once.
      fileStream.unpipe(req);
      req.destroy(err);
      reject(err);
    });

    // If the incoming file stream errors (e.g. client disconnected),
    // destroy the outgoing Bunny request and propagate the error.
    fileStream.on('error', (err) => {
      req.destroy();
      reject(err);
    });

    fileStream.pipe(req);
  });
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
};
