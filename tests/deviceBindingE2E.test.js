'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config();
const config = require('../src/config/env');
const bcrypt = require('bcrypt');
const prisma = require('../src/config/db');
const { login, refreshToken } = require('../src/controllers/authController');
const { unbindDeviceAdmin } = require('../src/controllers/deviceController');
const { randomBase36Slug } = require('../src/utils/slugs');

test('deviceBindingE2E: Comprehensive end-to-end device binding lifecycle', async () => {
  const email = 'e2e_student_' + Date.now() + '@example.com';
  const password = 'Password#12345';
  const hashedPassword = await bcrypt.hash(password, 10);

  const student = await prisma.user.create({
    data: {
      name: 'E2E Student',
      email,
      phoneNumber: '010' + Math.floor(10000000 + Math.random() * 90000000),
      password: hashedPassword,
      slug: randomBase36Slug(),
      role: 'STUDENT',
      grade: 'FIRST_SECONDARY',
    },
  });

  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
  });
  assert.ok(admin, 'Admin required for unbind action');

  const d1 = 'device_e2e_01_' + Date.now();
  const d2 = 'device_e2e_02_' + Date.now();
  const d3 = 'device_e2e_03_' + Date.now();
  const d4 = 'device_e2e_04_' + Date.now();

  const sessions = {};

  async function attemptLogin(userEmail, userPass, deviceId, userAgent = 'Mozilla/5.0') {
    const cookies = {};
    let status = 200;
    let body = null;
    const req = {
      body: { email: userEmail, password: userPass, device: { id: deviceId } },
      headers: { 'user-agent': userAgent },
      ip: '197.32.10.1',
    };
    const res = {
      cookie: (name, val) => { cookies[name] = val; },
      status: (code) => { status = code; return res; },
      json: (data) => { body = data; return data; },
    };
    await login(req, res);
    return { status, body, cookies };
  }

  async function attemptRefresh(refreshTokenCookie) {
    const cookies = {};
    let status = 200;
    let body = null;
    const req = {
      cookies: { refreshToken: refreshTokenCookie },
      headers: {},
      ip: '197.32.10.1',
    };
    const res = {
      cookie: (name, val) => { cookies[name] = val; },
      clearCookie: () => {},
      status: (code) => { status = code; return res; },
      json: (data) => { body = data; return data; },
    };
    await refreshToken(req, res);
    return { status, body, cookies };
  }

  try {
    // ── Test 1: Student logs in from Device 1, 2, 3 -> All succeed ─────────────
    const resD1 = await attemptLogin(email, password, d1, 'Chrome on Windows');
    assert.equal(resD1.status, 200);
    assert.equal(resD1.body.success, true);
    sessions[d1] = resD1.cookies;

    const resD2 = await attemptLogin(email, password, d2, 'Safari on iPhone');
    assert.equal(resD2.status, 200);
    assert.equal(resD2.body.success, true);
    sessions[d2] = resD2.cookies;

    const resD3 = await attemptLogin(email, password, d3, 'Chrome on Android');
    assert.equal(resD3.status, 200);
    assert.equal(resD3.body.success, true);
    sessions[d3] = resD3.cookies;
    console.log('Test 1 Passed: 3 devices registered successfully');

    // ── Test 2: Student attempts login from Device 4 -> Rejection 403 ──────────
    const resD4 = await attemptLogin(email, password, d4, 'Firefox on Linux');
    if (resD4.status !== 403) console.error('Test 2 failed, resD4:', resD4);
    assert.equal(resD4.status, 403);
    assert.equal(resD4.body.code, 'DEVICE_LIMIT_EXCEEDED');
    console.log('Test 2 Passed: 4th device rejected with 403 DEVICE_LIMIT_EXCEEDED');

    // ── Test 3: Concurrent refresh tokens rotate independently ─────────────────
    const refD1 = await attemptRefresh(sessions[d1].refreshToken);
    assert.equal(refD1.status, 200);
    sessions[d1] = refD1.cookies;

    const refD2 = await attemptRefresh(sessions[d2].refreshToken);
    assert.equal(refD2.status, 200);
    sessions[d2] = refD2.cookies;

    const refD3 = await attemptRefresh(sessions[d3].refreshToken);
    assert.equal(refD3.status, 200);
    sessions[d3] = refD3.cookies;
    console.log('Test 3 Passed: isolated refresh rotation');

    // ── Test 4: Admin unbinds Device 2 -> Student can now log in on Device 4 ───
    const unbindReq = {
      user: { id: admin.id, role: 'ADMIN' },
      params: { userSlug: student.slug, deviceIdentifier: d2 },
    };
    let unbindStatus = 200;
    let unbindBody = null;
    const unbindRes = {
      status: (code) => { unbindStatus = code; return unbindRes; },
      json: (data) => { unbindBody = data; return data; },
    };
    await unbindDeviceAdmin(unbindReq, unbindRes);
    assert.equal(unbindStatus, 200);
    assert.equal(unbindBody.success, true);

    // Device 4 login now succeeds
    const resD4AfterUnbind = await attemptLogin(email, password, d4, 'Firefox on Linux');
    assert.equal(resD4AfterUnbind.status, 200);
    assert.equal(resD4AfterUnbind.body.success, true);
    sessions[d4] = resD4AfterUnbind.cookies;
    console.log('Test 4 Passed: Admin unbind & Device 4 replacement');

    // ── Test 5: Unbound Device 2 refresh attempt fails with 403 DEVICE_REVOKED ─
    const refD2Revoked = await attemptRefresh(sessions[d2].refreshToken);
    assert.equal(refD2Revoked.status, 403);
    assert.equal(refD2Revoked.body.code, 'DEVICE_REVOKED');
    console.log('Test 5 Passed: revoked device token fails with 403 DEVICE_REVOKED');

    // ── Test 6: Admin user logs in on 5+ devices without restriction ───────────
    for (let i = 1; i <= 6; i++) {
      const adminDev = `admin_dev_${Date.now()}_${i}`;
      const adminLoginRes = await attemptLogin(admin.email, config.admin.password, adminDev);
      if (adminLoginRes.status !== 200) console.error('Test 6 failed at dev ' + i + ':', adminLoginRes);
      assert.equal(adminLoginRes.status, 200);
      assert.equal(adminLoginRes.body.success, true);
    }
    console.log('Test 6 Passed: Admin bypass');

  } finally {
    await prisma.userDevice.deleteMany({ where: { userId: student.id } });
    await prisma.user.delete({ where: { id: student.id } }).catch(() => {});
    await prisma.$disconnect();
    try {
      const { disconnectRedis, getRedis } = require('../src/integrations/redis/redisClient');
      const client = getRedis();
      if (client) client.disconnect();
      await disconnectRedis();
    } catch {}
  }
});
