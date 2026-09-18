'use strict';

const crypto = require('crypto');

const READABLE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const USER_SLUG_RE = /^u_[a-zA-Z0-9]{8,}$/;

/**
 * Turn a free-text title into a read-only URL slug.
 * Latin-alphanumeric only; anything else collapses to '-'. Returns '' when the
 * title has no usable ASCII content (e.g. Arabic), so callers must fall back.
 */
function slugifyTitle(title) {
  return String(title == null ? '' : title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Opaque, non-guessable user slug: "u_" + 24 hex chars (~96 bits).
 * Hex (not base64url) so the result always satisfies USER_SLUG_RE.
 */
function opaqueUserSlug() {
  return 'u_' + crypto.randomBytes(12).toString('hex');
}

function isValidSlug(slug) {
  return typeof slug === 'string' && slug.length >= 1 && slug.length <= 64 && READABLE_SLUG_RE.test(slug);
}

function isValidUserSlug(slug) {
  return typeof slug === 'string' && slug.length <= 64 && USER_SLUG_RE.test(slug);
}

/**
 * Ensure a slug is unique against a Prisma model. Retries with a numeric suffix
 * (base-2, base-3, ...). `fallbackPrefix` is used when the base slug is empty
 * (non-ASCII title) so races can always progress to a suffix.
 * @param {'Course'|'BunnyVideo'|'Quiz'|'User'} model prisma delegate name
 * @param {string} baseSlug slugifyTitle() output (may be '')
 * @param {string} fallbackPrefix stable prefix for the empty-title fallback
 */
async function uniqueSlug(model, baseSlug, fallbackPrefix) {
  const prisma = require('../config/db');
  let candidate = baseSlug || `${fallbackPrefix}-${crypto.randomBytes(3).toString('hex')}`;
  for (let suffix = 2; ; suffix += 1) {
    const existing = await prisma[model].findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!existing) return candidate;
    candidate = `${baseSlug || `${fallbackPrefix}-${crypto.randomBytes(3).toString('hex')}`}-${suffix}`;
  }
}

module.exports = {
  READABLE_SLUG_RE,
  USER_SLUG_RE,
  slugifyTitle,
  opaqueUserSlug,
  isValidSlug,
  isValidUserSlug,
  uniqueSlug,
};