'use strict';

/**
 * accountLockout.js
 * Redis-backed consecutive-failure lockout for the login endpoint.
 *
 * Policy: after LOGIN_FAILURE_THRESHOLD (default 5) consecutive failed logins
 * for an email, the account is locked for ACCOUNT_LOCKOUT_MS (default 15 min).
 * A successful login clears the counter. This complements the per-IP login
 * rate limiter: the limiter bounds attempts per IP; the lockout protects a
 * specific account from being battered even from many IPs (credential
 * stuffing / distributed brute force).
 *
 * Fail-open contract (mirrors cache.js): Redis is an accelerator, never a hard
 * dependency. If Redis is disabled, disconnected, or a command times out, the
 * lockout is skipped (returns not-locked, records nothing) — login proceeds on
 * the limiter alone. NEVER throw into the login path.
 *
 * Keys: `v1:authlock:{normalizedEmail}` (v1: namespace, consistent prefixes).
 */

const { getRedis, ensureConnected } = require('./redisClient');
const { buildKey } = require('./cache');

const COMMAND_TIMEOUT_MS = 500;

function readyClient() {
  const client = getRedis();
  if (!client) return null;
  if (client.status === 'ready') return client;
  void ensureConnected().catch(() => {});
  return null;
}

function withTimeout(promise, ms = COMMAND_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('redis lockout timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function threshold() {
  const raw = Number(process.env.LOGIN_FAILURE_THRESHOLD);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 5;
}

function windowMs() {
  const raw = Number(process.env.ACCOUNT_LOCKOUT_MS);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 15 * 60 * 1000;
}

function keyFor(email) {
  return buildKey('authlock', String(email || '').trim().toLowerCase());
}

/**
 * Returns { locked, failures, retryAfterMs } for an email. Fail-open: any
 * Redis problem resolves to { locked: false } so login is never blocked by the
 * lockout system being down (the rate limiter still applies).
 */
async function getLockState(email) {
  const client = readyClient();
  if (!client) return { locked: false, failures: 0, retryAfterMs: 0 };
  try {
    const key = keyFor(email);
    // Single Lua round-trip: the previous GET+TTL pair raced key expiry between
    // the two commands (could report locked with retryAfterMs 0). Returns
    // {failures, ttlSec}; a missing key returns {0, -2} (mirrors GET/TTL).
    const res = await withTimeout(
      client.eval(
        `local c = redis.call('GET', KEYS[1]); ` +
        `if not c then return {0, -2} end; ` +
        `return {tonumber(c) or 0, redis.call('TTL', KEYS[1])};`,
        1,
        key
      )
    );
    const failures = Number(res && res[0]) || 0;
    const ttl = Number(res && res[1]) || 0;
    const locked = failures >= threshold();
    return {
      locked,
      failures,
      retryAfterMs: locked ? Math.max(0, ttl) * 1000 : 0,
    };
  } catch {
    return { locked: false, failures: 0, retryAfterMs: 0 };
  }
}

/**
 * Record one failed login. Atomic INCR + first-hit expiry (same Lua pattern as
 * rateLimitStore — a crash between INCR and EXPIRE must not leave a
 * TTL-less counter). Fail-open no-op on Redis trouble.
 */
async function recordFailure(email) {
  const client = readyClient();
  if (!client) return { failed: false, failures: 0, locked: false };
  try {
    const key = keyFor(email);
    const count = await withTimeout(
      client.eval(
        `local c = redis.call('INCR', KEYS[1]); ` +
        `if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end; ` +
        `return c;`,
        1,
        key,
        String(windowMs())
      )
    );
    const failures = Number(count);
    return { failed: failures, failures, locked: failures >= threshold() };
  } catch {
    return { failed: false, failures: 0, locked: false };
  }
}

/** Clear the counter on a successful login. Fail-open no-op. */
async function clearFailures(email) {
  const client = readyClient();
  if (!client) return;
  try {
    await withTimeout(client.del(keyFor(email)));
  } catch {
    /* best-effort */
  }
}

module.exports = { getLockState, recordFailure, clearFailures, threshold, windowMs };