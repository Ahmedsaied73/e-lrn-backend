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

/**
 * Represents an error response from the Bunny API.
 * Carries the HTTP status code and raw response body for logging/compensation.
 */
class BunnyApiError extends Error {
  constructor(statusCode, body) {
    super(`Bunny API error ${statusCode}: ${body}`);
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
