'use strict';

/**
 * Verification test for Bunny Stream client and utilities
 * Validates HMAC webhook verification, signed token generator, and AppError exports.
 */

const assert = require('assert');
const crypto = require('crypto');

// Set dummy test env vars
process.env.JWTSECRET = 'test_jwt_secret';
process.env.ADMIN_PASSWORD = 'test_admin_password';
process.env.BUNNY_STREAM_LIBRARY_ID = '99999';
process.env.BUNNY_STREAM_API_KEY = 'test_api_key';
process.env.BUNNY_STREAM_READ_ONLY_API_KEY = 'test_read_only_webhook_key';
process.env.BUNNY_STREAM_TOKEN_KEY = 'test_token_key';
process.env.BUNNY_STREAM_TOKEN_TTL_SECONDS = '21600';

const bunnyClient = require('../src/integrations/bunny/bunnyStreamClient');
const { AppError, ErrorCodes } = require('../src/utils/AppError');
const bunnyVideoService = require('../src/services/bunnyVideoService');

console.log('--- RUNNING BUNNY STREAM INTEGRATION VERIFICATIONS ---');

// 1. Test AppError and ErrorCodes
assert(AppError, 'AppError class exists');
const err = new AppError('Test error', 404, ErrorCodes.VIDEO_NOT_FOUND);
assert.strictEqual(err.statusCode, 404);
assert.strictEqual(err.code, 'VIDEO_NOT_FOUND');
assert.strictEqual(err.message, 'Test error');
console.log('✓ AppError & ErrorCodes verified.');

// 2. Test Playback Token Generation
const videoId = '12345678-abcd-1234-abcd-1234567890ab';
const { token, expiresAt } = bunnyClient.generatePlaybackToken(videoId);
assert(token && typeof token === 'string', 'Token is generated as string');
assert(expiresAt > Math.floor(Date.now() / 1000), 'Expiry is in future');

// Verify token formula: SHA256(tokenKey + videoId + expires)
const expectedToken = crypto
  .createHash('sha256')
  .update('test_token_key' + videoId + expiresAt)
  .digest('hex');
assert.strictEqual(token, expectedToken, 'Token formula matches SHA256 specification');
console.log('✓ Signed Playback Token generation verified.');

// 3. Test Webhook HMAC Verification
const payload = JSON.stringify({ VideoGuid: videoId, Status: 3 });
const validSignature = crypto
  .createHmac('sha256', 'test_read_only_webhook_key')
  .update(payload, 'utf8')
  .digest('hex');

// Valid signature
const isValid = bunnyClient.verifyWebhookSignature({
  rawBody: payload,
  signature: validSignature,
  version: 'v1',
  algorithm: 'hmac-sha256',
});
assert.strictEqual(isValid, true, 'Valid webhook signature accepted');

// Tampered payload
const isTamperedValid = bunnyClient.verifyWebhookSignature({
  rawBody: payload + 'tampered',
  signature: validSignature,
  version: 'v1',
  algorithm: 'hmac-sha256',
});
assert.strictEqual(isTamperedValid, false, 'Tampered payload rejected');

// Invalid version
const isInvalidVersion = bunnyClient.verifyWebhookSignature({
  rawBody: payload,
  signature: validSignature,
  version: 'v2',
  algorithm: 'hmac-sha256',
});
assert.strictEqual(isInvalidVersion, false, 'Invalid version rejected');

console.log('✓ Webhook HMAC constant-time signature verification verified.');

// 4. Test Bunny status mapping
assert.strictEqual(bunnyVideoService.BUNNY_STATUS_MAP[0], 'PROCESSING');
assert.strictEqual(bunnyVideoService.BUNNY_STATUS_MAP[1], 'PROCESSING');
assert.strictEqual(bunnyVideoService.BUNNY_STATUS_MAP[2], 'PROCESSING');
assert.strictEqual(bunnyVideoService.BUNNY_STATUS_MAP[3], 'READY');
assert.strictEqual(bunnyVideoService.BUNNY_STATUS_MAP[4], 'READY');
assert.strictEqual(bunnyVideoService.BUNNY_STATUS_MAP[5], 'FAILED');
assert.strictEqual(bunnyVideoService.BUNNY_STATUS_MAP[6], undefined);
console.log('✓ Bunny status mapping table verified.');

console.log('\n ALL LOCAL INTEGRATION VERIFICATIONS PASSED SUCCESSFULLY! \n');
