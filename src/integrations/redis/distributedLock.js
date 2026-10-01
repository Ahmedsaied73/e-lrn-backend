'use strict';

/**
 * distributedLock.js
 * Token-based distributed lock shared by the cron jobs (reconcileStaleVideos,
 * reconcilePayments — see src/jobs/). Extracted so every job gets the same
 * acquire/release discipline:
 *
 * - Acquire: SET key token EX ttl NX. The token (pid + UUID) identifies the
 *   holder — a bare pid can't tell "my lock" from "another instance's lock".
 * - Release: Lua compare-and-delete — only the token holder deletes. This
 *   closes the race where a holder outlives its TTL, another instance takes
 *   the lock, and the stale holder's plain DEL drops the new holder's lock.
 * - Fail-open: Redis disabled/not-ready acquires as { acquired: true,
 *   token: null } (callers fall back to their process-local overlap guard);
 *   releasing a null token is a no-op — nothing is held in Redis.
 * - Command errors (timeout, disconnect) are THROWN so each caller logs its
 *   own event and decides; both cron jobs catch and proceed (fail-open).
 */

const crypto = require('crypto');
const { getRedis } = require('./redisClient');

const LOCK_COMMAND_TIMEOUT_MS = 3000;

// Compare-and-delete: returns 1 when we held the lock and released it, 0 when
// the key is gone or belongs to someone else (TTL expired → re-acquired).
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), LOCK_COMMAND_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Try to take the lock. Returns { acquired, token }:
 * - { true, token }  — lock held; pass token to releaseLock.
 * - { true, null }   — Redis off: fail-open acquire, nothing to release.
 * - { false, null }  — another instance holds the lock.
 * Throws on Redis command errors (callers log their own event + fail open).
 */
async function acquireLock(key, ttlSeconds) {
  const client = getRedis();
  if (!client || client.status !== 'ready') return { acquired: true, token: null };
  const token = `${process.pid}:${crypto.randomUUID()}`;
  const result = await withTimeout(
    client.set(key, token, 'EX', ttlSeconds, 'NX'),
    'lock acquire timeout'
  );
  return { acquired: result === 'OK', token: result === 'OK' ? token : null };
}

/**
 * Release the lock only if we still hold it (compare-and-delete). No-op when
 * token is null (fail-open acquisition) or Redis is down. Throws on Redis
 * command errors (callers log their own event; expiry is the backstop).
 */
async function releaseLock(key, token) {
  if (!token) return;
  const client = getRedis();
  if (!client || client.status !== 'ready') return;
  await withTimeout(client.eval(RELEASE_SCRIPT, 1, key, token), 'lock release timeout');
}

module.exports = { acquireLock, releaseLock };
