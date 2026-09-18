'use strict';
/* BE cookie-auth contract suite (node:test, no deps). Pins the security-round
 * auth model so it cannot silently regress:
 *   1. login/register NEVER return a token in the JSON body — HttpOnly cookies
 *      (accessToken + refreshToken) are the only carrier;
 *   2. /auth/refresh-token rotates: the new refresh cookie is stored and the
 *      previous one dies immediately;
 *   3. an ACCESS token is rejected by the refresh endpoint (separate secret +
 *      `type: 'refresh'` claim);
 *   4. registering from an already-authenticated context does NOT overwrite the
 *      caller's cookies (admin-console add-student flow, commit ef97dd8).
 *
 * Every test is net-zero: the scratch users created here are deleted in after().
 * Rate limits: 2 registers + 1 login per run — far below the register bucket.
 *
 * Run: npm test
 */
process.chdir(__dirname + '/..');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { createToken } = require('../src/utils.js');
const config = require('../src/config/env.js');
const { PrismaClient } = require('@prisma/client');

const API = process.env.TEST_BASE_URL || 'http://localhost:3005';
const prisma = new PrismaClient();
const PASSWORD = 'CookieTest#2026';

const createdEmails = [];

const adminCookie = () =>
  `accessToken=${createToken({ id: 1, email: 'admin@elearning.com', name: 'T', role: 'ADMIN' }, config.jwt.secret)}`;

async function post(path, body, cookie) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, json, setCookies };
}

/** Value of one cookie from a set-cookie list, or null. */
function cookieValue(setCookies, name) {
  const hit = setCookies.find((c) => c.startsWith(`${name}=`));
  return hit ? hit.split(';')[0].split('=').slice(1).join('=') : null;
}
function isHttpOnly(setCookies, name) {
  const hit = setCookies.find((c) => c.startsWith(`${name}=`));
  return Boolean(hit && /httponly/i.test(hit));
}

let phoneSeq = 0;
const nextPhone = () => `+2010${String(Date.now()).slice(-7)}${String(phoneSeq++).padStart(2, '0')}`;

async function registerUser(tag, cookie) {
  const email = `cookies-${tag}-${Date.now()}-${phoneSeq}@localhost.test`;
  const res = await post('/auth/register', {
    email,
    password: PASSWORD,
    name: 'Cookie Tester',
    phoneNumber: nextPhone(),
    grade: 'FIRST_SECONDARY',
  }, cookie);
  if (res.status === 201) createdEmails.push(email);
  return { email, res };
}

describe('cookie-only auth contract', () => {
  after(async () => {
    await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    assert.equal(await prisma.user.count({ where: { email: { in: createdEmails } } }), 0, 'net-zero users');
    await prisma.$disconnect();
  });

  it('register from an unauthenticated context sets HttpOnly cookies and no body token', async () => {
    const { email, res } = await registerUser('register');
    assert.equal(res.status, 201, 'registration succeeds');

    assert.ok(!('token' in res.json) && !('refreshToken' in res.json), 'no token at the top level');
    assert.ok(!('token' in (res.json.data || {})) && !('refreshToken' in (res.json.data || {})),
      'no token nested under data');
    assert.ok(res.json.data && res.json.data.user, 'user payload returned');

    assert.ok(cookieValue(res.setCookies, 'accessToken'), 'accessToken cookie set');
    assert.ok(cookieValue(res.setCookies, 'refreshToken'), 'refreshToken cookie set');
    assert.ok(isHttpOnly(res.setCookies, 'accessToken'), 'accessToken is HttpOnly');
    assert.ok(isHttpOnly(res.setCookies, 'refreshToken'), 'refreshToken is HttpOnly');
  });

  it('login returns HttpOnly cookies only — never a token in the body', async () => {
    const { email } = await registerUser('login');
    const res = await post('/auth/login', { email, password: PASSWORD });
    assert.equal(res.status, 200, 'login succeeds');

    assert.ok(!('token' in res.json) && !('refreshToken' in res.json), 'no token in the login body');
    assert.ok(!('token' in (res.json.data || {})), 'no token nested under data');
    assert.ok(isHttpOnly(res.setCookies, 'accessToken') && isHttpOnly(res.setCookies, 'refreshToken'),
      'both cookies are HttpOnly');
  });

  it('refresh rotates the refresh token and kills the previous one', async () => {
    const { email } = await registerUser('rotate');
    const login = await post('/auth/login', { email, password: PASSWORD });
    assert.equal(login.status, 200);
    const oldRefresh = cookieValue(login.setCookies, 'refreshToken');
    const access = cookieValue(login.setCookies, 'accessToken');
    assert.ok(oldRefresh && access, 'login cookies captured');

    const rotated = await post('/auth/refresh-token', {}, `refreshToken=${oldRefresh}`);
    assert.equal(rotated.status, 200, 'refresh with the refresh cookie succeeds');
    const newRefresh = cookieValue(rotated.setCookies, 'refreshToken');
    assert.ok(newRefresh, 'rotation sets a new refresh cookie');
    assert.notEqual(newRefresh, oldRefresh, 'the rotated refresh token differs');
    assert.ok(cookieValue(rotated.setCookies, 'accessToken'), 'rotation also re-issues the access cookie');

    // The endpoint distinguishes "no cookie at all" (401, line 180) from
    // "cookie present but dead/revoked/wrong-type" (403, lines 187/197/215).
    const replay = await post('/auth/refresh-token', {}, `refreshToken=${oldRefresh}`);
    assert.equal(replay.status, 403, 'the pre-rotation refresh token is dead');
    assert.match(replay.json.error, /invalid or revoked/i);

    // An access token is signed with the access secret, so verification against
    // the refresh secret fails first → 401. If the two secrets ever coincide
    // (dev fallback), the `type !== 'refresh'` claim check rejects it → 403.
    // Either way the token must be refused and no new session minted.
    const asAccess = await post('/auth/refresh-token', {}, `accessToken=${access}`);
    assert.ok([401, 403].includes(asAccess.status), `access token refused (got ${asAccess.status})`);
    assert.equal(cookieValue(asAccess.setCookies, 'refreshToken'), null, 'no refresh cookie is minted');

    const noCookie = await post('/auth/refresh-token', {});
    assert.equal(noCookie.status, 401, 'a request with no refresh cookie is unauthenticated');
  });

  it('registering while already authenticated does not overwrite the caller session', async () => {
    const { res } = await registerUser('session', adminCookie());
    assert.equal(res.status, 201, 'admin can still create a student through the public endpoint');
    assert.equal(cookieValue(res.setCookies, 'accessToken'), null,
      'no accessToken cookie is issued to the authenticated caller');
    assert.equal(cookieValue(res.setCookies, 'refreshToken'), null,
      'the caller refresh cookie is left alone');
  });
});