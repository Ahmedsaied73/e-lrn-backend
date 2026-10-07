'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../src/config/db');

test('UserDevice schema & User relation CRUD and constraints', async (t) => {
  // Find an existing student or admin to test relations
  const testUser = await prisma.user.findFirst({
    select: { id: true, email: true, maxDevices: true }
  });
  assert.ok(testUser, 'Expected at least one user in database');

  const testDeviceId = 'test_device_' + Date.now();

  let createdDevice;
  try {
    // 1. Create a UserDevice
    createdDevice = await prisma.userDevice.create({
      data: {
        userId: testUser.id,
        deviceIdentifier: testDeviceId,
        deviceName: 'Test Chrome on Windows 11',
        deviceType: 'DESKTOP',
        browser: 'Chrome 128.0',
        os: 'Windows 11',
        ipAddress: '127.0.0.1',
        userAgent: 'Mozilla/5.0 Test UA',
        refreshToken: 'sha256_mock_hash',
        refreshTokenFamily: 'fam_12345',
      }
    });

    assert.ok(createdDevice.id, 'UserDevice should have an auto-generated id');
    assert.equal(createdDevice.userId, testUser.id);
    assert.equal(createdDevice.deviceIdentifier, testDeviceId);
    assert.equal(createdDevice.deviceName, 'Test Chrome on Windows 11');
    assert.equal(createdDevice.deviceType, 'DESKTOP');
    assert.equal(createdDevice.revokedAt, null);

    // 2. Relation query via user
    const userWithDevices = await prisma.user.findUnique({
      where: { id: testUser.id },
      include: { devices: { where: { deviceIdentifier: testDeviceId } } }
    });
    assert.equal(userWithDevices.devices.length, 1);
    assert.equal(userWithDevices.devices[0].deviceIdentifier, testDeviceId);

    // 3. Unique constraint check on [userId, deviceIdentifier]
    await assert.rejects(
      prisma.userDevice.create({
        data: {
          userId: testUser.id,
          deviceIdentifier: testDeviceId,
          deviceName: 'Duplicate Device',
        }
      }),
      (err) => err.code === 'P2002',
      'Should reject duplicate userId + deviceIdentifier with P2002'
    );

    // 4. Update maxDevices on User
    const updatedUser = await prisma.user.update({
      where: { id: testUser.id },
      data: { maxDevices: 5 },
      select: { id: true, maxDevices: true }
    });
    assert.equal(updatedUser.maxDevices, 5);

    // Restore maxDevices
    await prisma.user.update({
      where: { id: testUser.id },
      data: { maxDevices: testUser.maxDevices }
    });

  } finally {
    // Cleanup
    if (createdDevice) {
      await prisma.userDevice.delete({
        where: { id: createdDevice.id }
      }).catch(() => {});
    }
  }
});
