'use strict';

/**
 * pii.js — the agent's PII policy, in one place (Phase 1).
 *
 * POLICY (approved product decision — do not change without the same approval):
 *   - EMAILS are redacted BEFORE any tool payload is handed to a model or a
 *     stream. The mask keeps the domain so an admin can still say "the gmail
 *     one" but never the address:  ahmed.saied@gmail.com -> a***@gmail.com
 *   - NAMES and PHONE NUMBERS are explicitly ALLOWED to leave the platform.
 *   - Nothing here is a security boundary for the database: it is an egress
 *     filter. Tools that return rows MUST run their payload through
 *     `redactPayload()` — the tool builder does it centrally, so a new tool
 *     cannot forget (see tools/_build.js).
 *
 * Design rules:
 *   - Pure functions, no imports, no config: trivially unit-testable.
 *   - Cycle-safe and depth-bounded (a tool result is JSON, never a graph).
 *   - Non-destructive: returns a new structure; the caller's object is never
 *     mutated (Prisma result objects are sometimes reused/inspected).
 *   - Dates pass through untouched (JSON.stringify handles them at the edge).
 */

// Deliberately permissive: matching a false positive (masking something that
// looked like an email) is harmless, missing a real address is not.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const MAX_DEPTH = 8;

/** True when the string contains at least one email-shaped token. */
function containsEmail(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  EMAIL_RE.lastIndex = 0;
  return EMAIL_RE.test(value);
}

/**
 * Mask one email: keep the first character of the local part + the domain.
 * Anything without an "@" is returned unchanged (never throws on junk).
 */
function maskEmail(email) {
  if (typeof email !== 'string') return email;
  const at = email.lastIndexOf('@');
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain) return email;
  return `${local.slice(0, 1)}***@${domain}`;
}

/** Replace every email inside free text, leaving the surrounding text intact. */
function redactEmailsInText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text.replace(EMAIL_RE, (match) => maskEmail(match));
}

/**
 * Deep-redact a JSON-ish payload (tool result). Arrays, plain objects and
 * strings are transformed; Dates/numbers/booleans/null pass through; anything
 * exotic is stringified by the JSON layer anyway, so it is copied as-is.
 */
function redactPayload(value, depth = 0) {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'string') return redactEmailsInText(value);
  if (type !== 'object') return value;
  if (value instanceof Date) return value;
  if (depth >= MAX_DEPTH) return '[truncated:depth]';
  if (Array.isArray(value)) return value.map((item) => redactPayload(item, depth + 1));

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    // A key can itself be an address (rare, but a map keyed by email would
    // otherwise leak through untouched).
    out[containsEmail(key) ? maskEmail(key) : key] = redactPayload(item, depth + 1);
  }
  return out;
}

module.exports = {
  EMAIL_RE,
  containsEmail,
  maskEmail,
  redactEmailsInText,
  redactPayload,
};
