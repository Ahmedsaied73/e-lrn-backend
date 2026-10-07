'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = require('../src/config/db');
const { jwt: jwtConfig } = require('../src/config/env');
const { login, refreshToken, logout } = require('../src/controllers/authController');

test('multiDeviceAuth: Isolated multi-device sessions and token rotation', async () => {
  // Create or get a test student
  const email = 'multidev_test_' + Date.now() + '@example.com';
  const rawPassword = 'Password123!';
  const hashedPassword = await bcrypt.hash(rawPassword, 10);

  const student = await prisma.user.create({
    data: {
      name: 'MultiDev Student',
      email,
      phoneNumber: '010' + Math.floor(10000000 + Math.random() * 90000000),
      password: hashedPassword,
      slug: 'u_test_' + Date.now(),
      role: 'STUDENT',
      grade: 'FIRST_SECONDARY',
    },
  });

  const dev1 = 'dev_alpha_' + Date.now();
  const dev2 = 'dev_beta_' + Date.now();

  try {
    // 1. Login on Device 1
    const cookiesDev1 = {};
    const req1 = {
      body: { email, password: rawPassword, device: { id: dev1 } },
      headers: { 'user-agent': 'Chrome on Windows' },
      ip: '127.0.0.1',
    };
    const res1 = {
      cookie: (name, val) => { cookiesDev1[name] = val; },
      json: (data) => data,
      status: () => res1,
    };

    const loginRes1 = await login(req1, res1);
    assert.equal(loginRes1.success, true);
    assert.equal(loginRes1.data.user.deviceId, dev1);
    assert.ok(cookiesDev1.accessToken);
    assert.ok(cookiesDev1.refreshToken);

    // 2. Login on Device 2
    const cookiesDev2 = {};
    const req2 = {
      body: { email, password: rawPassword, device: { id: dev2 } },
      headers: { 'user-agent': 'Safari on iPhone' },
      ip: '127.0.0.1',
    };
    const res2 = {
      cookie: (name, val) => { cookiesDev2[name] = val; },
      json: (data) => data,
      status: () => res2,
    };

    const loginRes2 = await login(req2, res2);
    assert.equal(loginRes2.success, true);
    assert.equal(loginRes2.data.user.deviceId, dev2);
    assert.ok(cookiesDev2.accessToken);
    assert.ok(cookiesDev2.refreshToken);

    // Verify both UserDevice records exist in DB
    const dev1Row = await prisma.userDevice.findUnique({
      where: { userId_deviceIdentifier: { userId: student.id, deviceIdentifier: dev1 } },
    });
    const dev2Row = await prisma.userDevice.findUnique({
      where: { userId_deviceIdentifier: { userId: student.id, deviceIdentifier: dev2 } },
    });
    assert.ok(dev1Row.refreshToken);
    assert.ok(dev2Row.refreshToken);
    assert.notEqual(dev1Row.refreshTokenFamily, dev2Row.refreshTokenFamily);

    // 3. Refresh token on Device 1
    const refreshedCookiesDev1 = {};
    const refreshReq1 = {
      cookies: { refreshToken: cookiesDev1.refreshToken },
      headers: {},
      ip: '127.0.0.1',
    };
    const refreshRes1 = {
      cookie: (name, val) => { refreshedCookiesDev1[name] = val; },
      json: (data) => data,
      status: () => refreshRes1,
    };

    const ref1Result = await refreshToken(refreshReq1, refreshRes1);
    assert.equal(ref1Result.success, true);
    assert.ok(refreshedCookiesDev1.refreshToken);

    // Verify Device 2 is STILL active and has its own valid token
    const refreshedCookiesDev2 = {};
    const refreshReq2 = {
      cookies: { refreshToken: cookiesDev2.refreshToken },
      headers: {},
      ip: '127.0.0.1',
    };
    const refreshRes2 = {
      cookie: (name, val) => { refreshedCookiesDev2[name] = val; },
      json: (data) => data,
      status: () => refreshRes2,
    };

    const ref2Result = await refreshToken(refreshReq2, refreshRes2);
    assert.equal(ref2Result.success, true);
    assert.ok(refreshedCookiesDev2.refreshToken);

    // 4. Logout Device 1 only
    let clearedCookies = {};
    const logoutReq1 = {
      cookies: { refreshToken: refreshedCookiesDev1.refreshToken },
    };
    const logoutRes1 = {
      clearCookie: (name) => { clearedCookies[name] = true; },
      json: (data) => data,
      status: () => logoutRes1,
    };
    const logoutResult = await logout(logoutReq1, logoutRes1);
    assert.equal(logoutResult.success, true);
    assert.ok(clearedCookies.accessToken);
    assert.ok(clearedCookies.refreshToken);

    // Device 1's token is now cleared in DB
    const dev1AfterLogout = await prisma.userDevice.findUnique({
      where: { userId_deviceIdentifier: { userId: student.id, deviceIdentifier: dev1 } },
    });
    assert.equal(dev1AfterLogout.refreshToken, null);

    // Device 2 is STILL working
    const refreshedCookiesDev2Again = {};
    const refreshReq2Again = {
      cookies: { refreshToken: refreshedCookiesDev2.refreshToken },
      headers: {},
      ip: '127.0.0.1',
    };
    const refreshRes2Again = {
      cookie: (name, val) => { refreshedCookiesDev2Again[name] = val; },
      json: (data) => data,
      status: () => refreshRes2Again,
    };
    const ref2Again = await refreshToken(refreshReq2Again, refreshRes2Again);
    assert.equal(ref2Again.success, true);

    // 5. Revoking Device 2 yields 403 DEVICE_REVOKED
    await prisma.userDevice.update({
      where: { id: dev2Row.id },
      data: { revokedAt: new Date() },
    });

    let statusCode = null;
    let errorBody = null;
    const revokedRefreshRes = {
      clearCookie: () => {},
      status: (code) => {
        statusCode = code;
        return {
          json: (body) => { errorBody = body; return body; },
        };
      },
    };
    await refreshToken({
      cookies: { refreshToken: refreshedCookiesDev2Again.refreshToken },
      headers: {},
    }, revokedRefreshRes);

    assert.equal(statusCode, 403);
    assert.equal(errorBody.code, 'DEVICE_REVOKED');

  } finally {
    await prisma.userDevice.deleteMany({ where: { userId: student.id } });
    await prisma.user.delete({ where: { id: student.id } }).catch(() => {});
    await prisma.$disconnect();
  }
});
