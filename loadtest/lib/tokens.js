'use strict';

/**
 * Loads pre-generated JWTs + fixture map from loadtest/.tokens.json
 * (produced by scripts/seedLoadTestCohort.js; gitignored — never commit).
 * open() runs in k6 init context.
 *
 * MEMORY (measured, errno=1455 OOM crash): each k6 VU instantiates the bundle
 * independently, so a module-scope JSON.parse of the 3MB token file cost
 * ~10-20MB per VU → 2000 preAllocated VUs exhausted the 8GB generator box at
 * ~35% init. SharedArray parses ONCE into a shared read-only segment all VUs
 * reference — the fix. The file payload is wrapped in a 1-element array.
 */
const { SharedArray } = require('k6/data');
const file = __ENV.JWT_FILE || '../.tokens.json';
const shared = new SharedArray('loadtest-tokens', () => {
  const parsed = JSON.parse(open(file));
  if (!parsed || !Array.isArray(parsed.users) || parsed.users.length === 0) {
    throw new Error(`No users in ${file} — run scripts/seedLoadTestCohort.js first`);
  }
  return [parsed];
});
const data = shared[0];

// Cookie header for a VU: round-robin over the cohort so concurrent VUs map to
// distinct students (reproduces per-user gate cache keys + per-user rows).
function cookieFor(vu) {
  const u = data.users[vu % data.users.length];
  return `accessToken=${u.jwt}`;
}

// Random cohort member (login surge: distinct credential per iteration).
function pickUser() {
  return data.users[Math.floor(Math.random() * data.users.length)];
}

// Fixture slugs resolved by the seeder (env override wins).
function slug(name, fallback) {
  return __ENV[name] || (data.courses && data.courses[name]) || fallback;
}

module.exports = { data, cookieFor, pickUser, slug };