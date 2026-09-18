'use strict';

const crypto = require('crypto');

// Opaque public URL identifiers: fixed 12 lowercase alphanumeric chars.
// Shared by User, Course, BunnyVideo and Quiz so no resource type is
// enumerable/predictable from its URL. ~62 bits of entropy.
const SLUG_RE = /^[a-z0-9]{12}$/;

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomBase36Slug(len = 12) {
  const out = [];
  // Rejection sampling over the byte space (252 = 7 * 36) keeps the mapping
  // from bytes to alphabet chars perfectly uniform — no modulo bias.
  while (out.length < len) {
    const bytes = crypto.randomBytes(len);
    for (let i = 0; i < bytes.length && out.length < len; i += 1) {
      if (bytes[i] < 252) out.push(ALPHABET[bytes[i] % 36]);
    }
  }
  return out.join('');
}

function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

module.exports = {
  SLUG_RE,
  randomBase36Slug,
  isValidSlug,
};