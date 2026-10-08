'use strict';

const prisma = require('../config/db');
const config = require('../config/env');
const { AppError } = require('../utils/AppError');
const { parseUserAgent, isValidDeviceId } = require('../utils/deviceHelper');
const audit = require('./auditLog');

/**
 * Validates whether the device can log in or registers it as a new active device.
 * Admins are exempt from the 3-device limit.
 */
async function validateOrRegisterDevice({ user, devicePayload, ip, userAgent }) {
  const isAdmin = user.role === 'ADMIN';

  // Handle ADMIN bypass
  if (isAdmin) {
    let deviceId = devicePayload && devicePayload.id;
    if (!deviceId || !isValidDeviceId(deviceId)) {
      deviceId = `admin_dev_${user.id}_${Buffer.from(userAgent || 'default').toString('base64url').slice(0, 16)}`;
    } else {
      deviceId = String(deviceId).trim();
    }
    const parsed = parseUserAgent(userAgent);
    const device = await prisma.userDevice.upsert({
      where: {
        userId_deviceIdentifier: {
          userId: user.id,
          deviceIdentifier: deviceId,
        },
      },
      update: {
        lastActiveAt: new Date(),
        ipAddress: ip,
        userAgent: userAgent || undefined,
        revokedAt: null,
      },
      create: {
        userId: user.id,
        deviceIdentifier: deviceId,
        deviceName: parsed.deviceName,
        deviceType: parsed.deviceType,
        browser: parsed.browser,
        os: parsed.os,
        ipAddress: ip,
        userAgent: userAgent,
      },
    });
    return device;
  }

  // Student device validation
  let deviceId = devicePayload && devicePayload.id;
  if (!deviceId) {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(`${user.id}:${ip || '127.0.0.1'}:${userAgent || 'ua'}`).digest('hex').slice(0, 20);
    deviceId = `dev_${hash}`;
  } else if (!isValidDeviceId(deviceId)) {
    throw new AppError('معرّف الجهاز غير صالح.', 400, 'INVALID_DEVICE_ID');
  } else {
    deviceId = String(deviceId).trim();
  }

  const parsed = parseUserAgent(userAgent);

  // Fast path for active, recognized device without locking
  const existingFast = await prisma.userDevice.findUnique({
    where: {
      userId_deviceIdentifier: {
        userId: user.id,
        deviceIdentifier: deviceId,
      },
    },
  });

  if (existingFast && !existingFast.revokedAt) {
    return await prisma.userDevice.update({
      where: { id: existingFast.id },
      data: {
        lastActiveAt: new Date(),
        ipAddress: ip,
        userAgent: userAgent || existingFast.userAgent,
      },
    });
  }

  // New or reactivated device registration wrapped in transaction with row lock
  // to eliminate concurrent registration race conditions exceeding maxDevices
  return await prisma.$transaction(async (tx) => {
    // Acquire exclusive lock on the student's User row to serialize concurrent logins
    await tx.$executeRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;

    const existingDevice = await tx.userDevice.findUnique({
      where: {
        userId_deviceIdentifier: {
          userId: user.id,
          deviceIdentifier: deviceId,
        },
      },
    });

    if (existingDevice && !existingDevice.revokedAt) {
      return await tx.userDevice.update({
        where: { id: existingDevice.id },
        data: {
          lastActiveAt: new Date(),
          ipAddress: ip,
          userAgent: userAgent || existingDevice.userAgent,
        },
      });
    }

    // Fetch all active devices for this user
    const activeDevices = await tx.userDevice.findMany({
      where: {
        userId: user.id,
        revokedAt: null,
      },
      orderBy: {
        lastActiveAt: 'desc',
      },
    });

    // Check if there is an existing logged-out device matching this hardware profile
    // (e.g. user logged out, and browser updated or storage was refreshed)
    const loggedOutCandidate = activeDevices.find((d) => {
      // Must be a previously authenticated device that is now logged out
      if (d.refreshToken !== null || !d.refreshTokenFamily) return false;

      // Never match on unknown OS/browser fallbacks
      if (!d.os || d.os === 'Unknown OS' || !parsed.os || parsed.os === 'Unknown OS') return false;
      if (!d.browser || d.browser === 'Unknown Browser' || !parsed.browser || parsed.browser === 'Unknown Browser') return false;

      const sameType = d.deviceType === parsed.deviceType;
      const sameOs = d.os === parsed.os || d.os.split(' ')[0] === parsed.os.split(' ')[0];
      const sameBrowserFamily = d.browser === parsed.browser || d.browser.split(' ')[0] === parsed.browser.split(' ')[0];
      return sameType && sameOs && sameBrowserFamily;
    });

    if (loggedOutCandidate) {
      return await tx.userDevice.update({
        where: { id: loggedOutCandidate.id },
        data: {
          deviceIdentifier: deviceId,
          deviceName: parsed.deviceName,
          deviceType: parsed.deviceType,
          browser: parsed.browser,
          os: parsed.os,
          ipAddress: ip,
          userAgent: userAgent || loggedOutCandidate.userAgent,
          lastActiveAt: new Date(),
        },
      });
    }

    const activeCount = activeDevices.length;
    const maxAllowed = user.maxDevices || config.deviceBinding.maxDevicesPerStudent || 3;

    if (activeCount >= maxAllowed) {
      throw new AppError(
        `تم بلوغ الحد الأقصى للأجهزة (${maxAllowed} أجهزة). يرجى التواصل مع الدعم الفني لإدارة أجهزتك.`,
        403,
        'DEVICE_LIMIT_EXCEEDED'
      );
    }

    if (existingDevice && existingDevice.revokedAt) {
      return await tx.userDevice.update({
        where: { id: existingDevice.id },
        data: {
          revokedAt: null,
          lastActiveAt: new Date(),
          ipAddress: ip,
          userAgent: userAgent,
          deviceName: parsed.deviceName,
          deviceType: parsed.deviceType,
          browser: parsed.browser,
          os: parsed.os,
        },
      });
    }

    return await tx.userDevice.create({
      data: {
        userId: user.id,
        deviceIdentifier: deviceId,
        deviceName: parsed.deviceName,
        deviceType: parsed.deviceType,
        browser: parsed.browser,
        os: parsed.os,
        ipAddress: ip,
        userAgent: userAgent,
      },
    });
  });
}

/**
 * Unbinds a single device for a student (Admin action).
 */
async function unbindDevice(req, userId, deviceIdentifier) {
  const cleanIdentifier = typeof deviceIdentifier === 'string' ? deviceIdentifier.trim() : deviceIdentifier;
  const device = await prisma.userDevice.findUnique({
    where: {
      userId_deviceIdentifier: {
        userId,
        deviceIdentifier: cleanIdentifier,
      },
    },
  });

  if (!device || device.revokedAt) {
    throw new AppError('الجهاز غير موجود أو تم إلغاء ربطه بالفعل.', 404, 'DEVICE_NOT_FOUND');
  }

  await prisma.userDevice.update({
    where: { id: device.id },
    data: {
      revokedAt: new Date(),
      refreshToken: null,
      refreshTokenFamily: null,
    },
  });

  await audit.record(req, {
    action: 'STUDENT_DEVICE_UNBIND',
    targetType: 'UserDevice',
    targetId: device.id,
    metadata: {
      studentId: userId,
      deviceIdentifier,
      deviceName: device.deviceName,
    },
  });

  return { success: true, message: 'تم إلغاء ربط الجهاز بنجاح' };
}

/**
 * Resets all active devices for a student (Admin action).
 */
async function resetAllDevices(req, userId) {
  const result = await prisma.userDevice.updateMany({
    where: {
      userId,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
      refreshToken: null,
      refreshTokenFamily: null,
    },
  });

  await audit.record(req, {
    action: 'STUDENT_DEVICE_RESET_ALL',
    targetType: 'User',
    targetId: userId,
    metadata: {
      studentId: userId,
      unboundCount: result.count,
    },
  });

  return { success: true, count: result.count, message: 'تمت إعادة تعيين جميع أجهزة الطالب بنجاح' };
}

/**
 * Retrieves all active devices for a student.
 */
async function getStudentDevices(userId) {
  const [devices, user] = await Promise.all([
    prisma.userDevice.findMany({
      where: {
        userId,
        revokedAt: null,
      },
      orderBy: {
        lastActiveAt: 'desc',
      },
      select: {
        id: true,
        deviceIdentifier: true,
        deviceName: true,
        deviceType: true,
        browser: true,
        os: true,
        ipAddress: true,
        lastActiveAt: true,
        createdAt: true,
      },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { maxDevices: true },
    }),
  ]);

  const maxDevices = user?.maxDevices || config.deviceBinding.maxDevicesPerStudent || 3;

  return {
    devices,
    activeCount: devices.length,
    maxDevices,
  };
}

/**
 * Updates a student's custom max devices limit (Admin action).
 */
async function updateDeviceLimit(req, userId, maxDevices) {
  const parsedLimit = maxDevices === null || maxDevices === undefined || maxDevices === ''
    ? null
    : Number(maxDevices);

  if (parsedLimit !== null && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1)) {
    throw new AppError('الحد الأقصى للأجهزة يجب أن يكون رقماً صحيحاً موجباً.', 400, 'INVALID_INPUT');
  }

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: { maxDevices: parsedLimit },
    select: { id: true, maxDevices: true },
  });

  await audit.record(req, {
    action: 'STUDENT_DEVICE_LIMIT_UPDATE',
    targetType: 'User',
    targetId: userId,
    metadata: {
      maxDevices: parsedLimit,
    },
  });

  return {
    success: true,
    maxDevices: updatedUser.maxDevices || config.deviceBinding.maxDevicesPerStudent || 3,
  };
}

module.exports = {
  validateOrRegisterDevice,
  unbindDevice,
  resetAllDevices,
  getStudentDevices,
  updateDeviceLimit,
};
