'use strict';

/**
 * softDelete.js — the one definition of the soft-delete contract (Phase 8,
 * decision #19 + Q5).
 *
 * Everything that needs to know "how long is the window" or "what does a
 * tombstoned address look like" reads it from here, so the delete path and the
 * purge job can never disagree about either. A purge window that drifted from the
 * delete path's promise would either destroy recoverable rows early or leave them
 * forever — both silent, both bad.
 */

/**
 * How long a soft-deleted user or course stays recoverable.
 *
 * WHY 30: decision #19's window, and the same number the conversation and memory
 * sweeps use (AI_AGENT_CONVERSATION_RETENTION_DAYS / AI_AGENT_MEMORY_RETENTION_DAYS).
 * Kept as a literal here rather than an env var because it is part of a promise
 * made to the admin in the chat confirmation ("قابل للاسترجاع لمدة ٣٠ يوماً") —
 * an env tweak would make that sentence a lie with no visible signal.
 */
const SOFT_DELETE_RETENTION_DAYS = 30;

/**
 * Reserved TLD (RFC 2606) — guaranteed never to resolve, so a tombstoned address
 * can never be delivered to and can never collide with a real registration.
 */
const TOMBSTONE_DOMAIN = 'deleted.invalid';

/**
 * The address a soft-deleted user's live `email` column is overwritten with.
 *
 * WHY a per-user tombstone instead of a shared literal or NULL: `User.email` is
 * UNIQUE and NOT NULL. NULL would violate the constraint, and a shared value would
 * make the second delete collide with the first. The user's own `slug` is already
 * unique and immutable, so the tombstone inherits uniqueness for free — and a
 * partial index or a `WHERE deletedAt IS NULL` allowance (the other common
 * designs) would mean changing the constraint on a table production reads on
 * every login.
 *
 * @param {string} slug - the user's 12-char opaque slug
 * @returns {string} e.g. "deleted+a1b2c3d4e5f6@deleted.invalid"
 */
function softDeleteTombstoneEmail(slug) {
  return `deleted+${slug}@${TOMBSTONE_DOMAIN}`;
}

/** True when the given value is a tombstone this module produced. */
function isTombstoneEmail(email) {
  return typeof email === 'string' && email.endsWith(`@${TOMBSTONE_DOMAIN}`);
}

/**
 * The predicate every list/search/count query over User or Course must now carry.
 * Exported as a value (not inlined as `{ deletedAt: null }` per call site) so the
 * filter is greppable: `git grep LIVE_ROW` lists every place that has the rule.
 */
const LIVE_ROW = { deletedAt: null };

module.exports = {
  SOFT_DELETE_RETENTION_DAYS,
  TOMBSTONE_DOMAIN,
  LIVE_ROW,
  softDeleteTombstoneEmail,
  isTombstoneEmail,
};
