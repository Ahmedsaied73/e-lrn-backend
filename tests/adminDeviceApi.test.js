'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../src/config/db');
const {
  getMyDevices,
  getStudentDevicesAdmin,
  unbindDeviceAdmin,
  resetStudentDevicesAdmin,
  updateStudentDeviceLimitAdmin,
} = require('../src/controllers/deviceController');

test('deviceController: student and admin device API handlers', async () => {
  const student = await prisma.user.create({
    data: {
      name: 'AdminDeviceApi Student',
      email: 'admindev_' + Date.now() + '@example.test',
      phoneNumber: '010' + Math.floor(10000000 + Math.random() * 90000000),
      password: 'hash',
      slug: 'u_admindev_' + Date.now(),
      role: 'STUDENT',
      grade: 'FIRST_SECONDARY',
    },
  });
  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
  });

  assert.ok(student, 'Expected student');
  assert.ok(admin, 'Expected admin');

  const devId = 'api_test_dev_' + Date.now();

  // Create a device for student
  const createdDevice = await prisma.userDevice.create({
    data: {
      userId: student.id,
      deviceIdentifier: devId,
      deviceName: 'Chrome on Mac OS',
      deviceType: 'DESKTOP',
      browser: 'Chrome 128',
      os: 'Mac OS 14',
      ipAddress: '197.32.1.5',
    },
  });

  try {
    // 1. GET /user/me/devices
    const myReq = { user: { id: student.id, role: 'STUDENT' } };
    let myResData = null;
    const myRes = {
      json: (data) => { myResData = data; return data; },
      status: () => myRes,
    };
    await getMyDevices(myReq, myRes);
    assert.equal(myResData.success, true);
    assert.ok(Array.isArray(myResData.data.devices));
    assert.ok(myResData.data.devices.some((d) => d.deviceIdentifier === devId));

    // 2. GET /admin/users/:userSlug/devices
    const adminGetReq = {
      user: { id: admin.id, role: 'ADMIN' },
      params: { userSlug: student.slug },
    };
    let adminGetData = null;
    const adminGetRes = {
      json: (data) => { adminGetData = data; return data; },
      status: () => adminGetRes,
    };
    await getStudentDevicesAdmin(adminGetReq, adminGetRes);
    assert.equal(adminGetData.success, true);
    assert.equal(adminGetData.data.student.id, student.id);
    assert.ok(adminGetData.data.devices.some((d) => d.deviceIdentifier === devId));

    // 3. PATCH /admin/users/:userSlug/device-limit
    const limitReq = {
      user: { id: admin.id, role: 'ADMIN' },
      params: { userSlug: student.slug },
      body: { maxDevices: 4 },
    };
    let limitData = null;
    const limitRes = {
      json: (data) => { limitData = data; return data; },
      status: () => limitRes,
    };
    await updateStudentDeviceLimitAdmin(limitReq, limitRes);
    assert.equal(limitData.success, true);
    assert.equal(limitData.data.maxDevices, 4);

    // 4. DELETE /admin/users/:userSlug/devices/:deviceIdentifier
    const unbindReq = {
      user: { id: admin.id, role: 'ADMIN' },
      params: { userSlug: student.slug, deviceIdentifier: devId },
    };
    let unbindData = null;
    const unbindRes = {
      json: (data) => { unbindData = data; return data; },
      status: () => unbindRes,
    };
    await unbindDeviceAdmin(unbindReq, unbindRes);
    assert.equal(unbindData.success, true);

    const checkRevoked = await prisma.userDevice.findUnique({
      where: { id: createdDevice.id },
    });
    assert.ok(checkRevoked.revokedAt !== null);

    // 5. POST /admin/users/:userSlug/devices/reset
    const resetReq = {
      user: { id: admin.id, role: 'ADMIN' },
      params: { userSlug: student.slug },
    };
    let resetData = null;
    const resetRes = {
      json: (data) => { resetData = data; return data; },
      status: () => resetRes,
    };
    await resetStudentDevicesAdmin(resetReq, resetRes);
    assert.equal(resetData.success, true);

  } finally {
    await prisma.userDevice.deleteMany({ where: { userId: student.id } });
    await prisma.user.delete({ where: { id: student.id } }).catch(() => {});
    await prisma.$disconnect();
  }
});
