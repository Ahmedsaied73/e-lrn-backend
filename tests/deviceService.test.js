'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../src/config/db');
const { parseUserAgent, isValidDeviceId } = require('../src/utils/deviceHelper');
const deviceService = require('../src/services/deviceService');
const { AppError } = require('../src/utils/AppError');

test('deviceHelper: parseUserAgent and isValidDeviceId', () => {
  assert.equal(isValidDeviceId(''), false);
  assert.equal(isValidDeviceId('short'), false);
  assert.equal(isValidDeviceId(null), false);
  assert.equal(isValidDeviceId(12345678), false);
  assert.equal(isValidDeviceId('valid_device_id_123'), true);
  assert.equal(isValidDeviceId('a'.repeat(64)), true);
  assert.equal(isValidDeviceId('a'.repeat(65)), false);

  const iphoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
  const iphoneParsed = parseUserAgent(iphoneUA);
  assert.equal(iphoneParsed.deviceType, 'MOBILE');
  assert.ok(iphoneParsed.os.includes('iOS'));

  const windowsUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
  const windowsParsed = parseUserAgent(windowsUA);
  assert.equal(windowsParsed.deviceType, 'DESKTOP');
  assert.ok(windowsParsed.browser.includes('Chrome'));
  assert.ok(windowsParsed.os.includes('Windows'));
});

test('deviceService: Student 3-device binding and Admin bypass', async (t) => {
  const student = await prisma.user.create({
    data: {
      name: 'DeviceService Test Student',
      email: 'devserv_' + Date.now() + '@example.test',
      phoneNumber: '010' + Math.floor(10000000 + Math.random() * 90000000),
      password: 'hash',
      slug: 'u_devserv_' + Date.now(),
      role: 'STUDENT',
      grade: 'FIRST_SECONDARY',
    },
  });
  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
  });

  assert.ok(student, 'Expected at least one student');
  assert.ok(admin, 'Expected at least one admin');

  const dev1 = 'dev_test_1_' + Date.now();
  const dev2 = 'dev_test_2_' + Date.now();
  const dev3 = 'dev_test_3_' + Date.now();
  const dev4 = 'dev_test_4_' + Date.now();

  try {
    // 1. Student registers Device 1
    const d1 = await deviceService.validateOrRegisterDevice({
      user: student,
      devicePayload: { id: dev1 },
      ip: '197.32.1.1',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    });
    assert.equal(d1.deviceIdentifier, dev1);
    assert.equal(d1.revokedAt, null);

    // 2. Student registers Device 2 & 3
    await deviceService.validateOrRegisterDevice({
      user: student,
      devicePayload: { id: dev2 },
      ip: '197.32.1.2',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4)',
    });

    await deviceService.validateOrRegisterDevice({
      user: student,
      devicePayload: { id: dev3 },
      ip: '197.32.1.3',
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_4)',
    });

    const activeList = await deviceService.getStudentDevices(student.id);
    assert.equal(activeList.activeCount, 3);
    assert.equal(activeList.devices.length, 3);

    // 3. Re-login from Device 1 should SUCCEED (already registered)
    const d1Relogin = await deviceService.validateOrRegisterDevice({
      user: student,
      devicePayload: { id: dev1 },
      ip: '197.32.1.99', // network roaming
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    });
    assert.equal(d1Relogin.deviceIdentifier, dev1);

    // 4. Student attempts Device 4 -> MUST THROW 403 DEVICE_LIMIT_EXCEEDED
    await assert.rejects(
      deviceService.validateOrRegisterDevice({
        user: student,
        devicePayload: { id: dev4 },
        ip: '197.32.1.4',
        userAgent: 'Mozilla/5.0 (Linux; Android 14)',
      }),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 403);
        assert.equal(err.code, 'DEVICE_LIMIT_EXCEEDED');
        return true;
      }
    );

    // 5. Admin unbinds Device 2
    const mockReq = { user: { id: admin.id, role: 'ADMIN' }, ip: '127.0.0.1' };
    const unbindRes = await deviceService.unbindDevice(mockReq, student.id, dev2);
    assert.equal(unbindRes.success, true);

    const afterUnbind = await deviceService.getStudentDevices(student.id);
    assert.equal(afterUnbind.activeCount, 2);

    // 6. Now Device 4 should succeed
    const d4 = await deviceService.validateOrRegisterDevice({
      user: student,
      devicePayload: { id: dev4 },
      ip: '197.32.1.4',
      userAgent: 'Mozilla/5.0 (Linux; Android 14)',
    });
    assert.equal(d4.deviceIdentifier, dev4);

    // 7. Reset all devices for student
    const resetRes = await deviceService.resetAllDevices(mockReq, student.id);
    assert.equal(resetRes.success, true);
    assert.equal(resetRes.count, 3); // dev1, dev3, dev4

    const afterReset = await deviceService.getStudentDevices(student.id);
    assert.equal(afterReset.activeCount, 0);

    // 8. Custom device limit update
    const limitRes = await deviceService.updateDeviceLimit(mockReq, student.id, 5);
    assert.equal(limitRes.maxDevices, 5);

    // Reset back to standard 3 limit for concurrency race test
    await deviceService.updateDeviceLimit(mockReq, student.id, 3);

    // 9. Admin bypass test
    const adminDev = await deviceService.validateOrRegisterDevice({
      user: admin,
      devicePayload: { id: 'admin_test_' + Date.now() },
      ip: '10.0.0.1',
      userAgent: 'Mozilla/5.0 (Admin Browser)',
    });
    assert.ok(adminDev.id);

    // 10. Concurrency race condition test on 3rd slot:
    // Student currently has 0 active devices (was reset in step 7).
    // Register Device A and Device B (student now has 2 active devices).
    await deviceService.validateOrRegisterDevice({
      user: student,
      devicePayload: { id: 'race_dev_A_' + Date.now() },
      ip: '197.32.1.10',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
    });
    await deviceService.validateOrRegisterDevice({
      user: student,
      devicePayload: { id: 'race_dev_B_' + Date.now() },
      ip: '197.32.1.11',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
    });
    const beforeRace = await deviceService.getStudentDevices(student.id);
    assert.equal(beforeRace.activeCount, 2);

    // Now launch 2 simultaneous registrations for Device C and Device D (both new devices)
    const raceDevC = 'race_dev_C_' + Date.now();
    const raceDevD = 'race_dev_D_' + Date.now();

    const [raceResC, raceResD] = await Promise.allSettled([
      deviceService.validateOrRegisterDevice({
        user: student,
        devicePayload: { id: raceDevC },
        ip: '197.32.1.12',
        userAgent: 'Mozilla/5.0 (Linux; Android 14)',
      }),
      deviceService.validateOrRegisterDevice({
        user: student,
        devicePayload: { id: raceDevD },
        ip: '197.32.1.13',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4)',
      }),
    ]);

    // Exactly one must succeed and exactly one must fail with DEVICE_LIMIT_EXCEEDED!
    const fulfilled = [raceResC, raceResD].filter((r) => r.status === 'fulfilled');
    const rejected = [raceResC, raceResD].filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'Exactly one concurrent registration should succeed');
    assert.equal(rejected.length, 1, 'Exactly one concurrent registration should be rejected');
    assert.equal(rejected[0].reason.code, 'DEVICE_LIMIT_EXCEEDED');

    // Total active devices must never exceed 3
    const afterRace = await deviceService.getStudentDevices(student.id);
    assert.equal(afterRace.activeCount, 3, 'Active device count must strictly be capped at 3');

    // 11. Whitespace trimming test
    const spaceId = '  space_dev_' + Date.now() + '  ';
    const trimmedDev = await deviceService.validateOrRegisterDevice({
      user: admin,
      devicePayload: { id: spaceId },
      ip: '10.0.0.1',
      userAgent: 'Mozilla/5.0 (Admin Browser)',
    });
    assert.equal(trimmedDev.deviceIdentifier, spaceId.trim());

  } finally {
    // Cleanup
    await prisma.userDevice.deleteMany({
      where: { userId: student.id },
    });
    await prisma.user.delete({
      where: { id: student.id },
    }).catch(() => {});
  }
});

test('deviceService: Re-login exact match and logged-out device reconciliation', async () => {
  const student = await prisma.user.create({
    data: {
      name: 'Reconciliation Student',
      email: 'reconcile_' + Date.now() + '@example.test',
      phoneNumber: '010' + Math.floor(10000000 + Math.random() * 90000000),
      password: 'hash',
      slug: 'u_rec_' + Date.now(),
      role: 'STUDENT',
      grade: 'FIRST_SECONDARY',
    },
  });

  const devId1 = 'dev_win_chrome_1_' + Date.now();
  const devId2 = 'dev_win_chrome_2_' + Date.now();
  const windowsUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
  const updatedWindowsUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

  try {
    // 1. Initial login on Windows Chrome
    const d1 = await deviceService.validateOrRegisterDevice({
      user: student,
      devicePayload: { id: devId1 },
      ip: '79.127.178.82',
      userAgent: windowsUA,
    });
    assert.equal(d1.deviceIdentifier, devId1);

    // Set active refreshToken and family
    await prisma.userDevice.update({
      where: { id: d1.id },
      data: { refreshToken: 'token_active_123', refreshTokenFamily: 'family_123' },
    });

    let devices = await deviceService.getStudentDevices(student.id);
    assert.equal(devices.activeCount, 1);

    // 2. User logs out: refreshToken is cleared to null
    await prisma.userDevice.update({
      where: { id: d1.id },
      data: { refreshToken: null },
    });

    // 3. User logs back in with the SAME device ID -> exact match reuses same row
    const d1Relogin = await deviceService.validateOrRegisterDevice({
      user: student,
      devicePayload: { id: devId1 },
      ip: '79.127.178.82',
      userAgent: windowsUA,
    });
    assert.equal(d1Relogin.id, d1.id);
    assert.equal(d1Relogin.deviceIdentifier, devId1);

    devices = await deviceService.getStudentDevices(student.id);
    assert.equal(devices.activeCount, 1, 'Exact re-login should not create a new device');

    // 4. User logs out again
    await prisma.userDevice.update({
      where: { id: d1.id },
      data: { refreshToken: null },
    });

    // 5. User logs back in on the SAME PC, but browser updated to Chrome 155 with a new device ID devId2
    const dReconciled = await deviceService.validateOrRegisterDevice({
      user: student,
      devicePayload: { id: devId2 },
      ip: '79.127.178.81',
      userAgent: updatedWindowsUA,
    });

    // It MUST reconcile with the logged-out row (same row ID), updating the deviceIdentifier!
    assert.equal(dReconciled.id, d1.id, 'Should reconcile existing logged-out device row');
    assert.equal(dReconciled.deviceIdentifier, devId2, 'Should update deviceIdentifier to current ID');

    devices = await deviceService.getStudentDevices(student.id);
    assert.equal(devices.activeCount, 1, 'Reconciliation should not increase active device count');

  } finally {
    await prisma.userDevice.deleteMany({
      where: { userId: student.id },
    });
    await prisma.user.delete({
      where: { id: student.id },
    }).catch(() => {});
    await prisma.$disconnect();
  }
});

