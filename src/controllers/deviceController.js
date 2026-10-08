'use strict';

const prisma = require('../config/db');
const deviceService = require('../services/deviceService');
const { AppError } = require('../utils/AppError');


async function findUserBySlugOrId(identifier) {
  if (!identifier || typeof identifier !== 'string') return null;
  const user = await prisma.user.findUnique({
    where: { slug: identifier },
    select: { id: true, name: true, email: true, slug: true, role: true, grade: true, maxDevices: true },
  });
  if (user) return user;

  const numId = Number(identifier);
  if (Number.isSafeInteger(numId) && numId > 0) {
    return await prisma.user.findUnique({
      where: { id: numId },
      select: { id: true, name: true, email: true, slug: true, role: true, grade: true, maxDevices: true },
    });
  }
  return null;
}

function handleControllerError(res, error, defaultMsg) {
  if (error instanceof AppError || (error.statusCode && error.code)) {
    return res.status(error.statusCode).json({
      success: false,
      error: error.message,
      code: error.code,
    });
  }
  console.error(defaultMsg, error);
  return res.status(500).json({ success: false, error: defaultMsg });
}

/**
 * GET /user/me/devices
 * Returns active devices for the current authenticated user.
 */
async function getMyDevices(req, res) {
  try {
    const data = await deviceService.getStudentDevices(req.user.id);
    return res.json({ success: true, data });
  } catch (error) {
    return handleControllerError(res, error, 'Failed to retrieve registered devices.');
  }
}

/**
 * GET /admin/users/:userSlug/devices
 * Returns registered devices for a given student (Admin only).
 */
async function getStudentDevicesAdmin(req, res) {
  try {
    const student = await findUserBySlugOrId(req.params.userSlug);
    if (!student) {
      return res.status(404).json({ success: false, error: 'User not found.', code: 'USER_NOT_FOUND' });
    }

    const result = await deviceService.getStudentDevices(student.id);
    return res.json({
      success: true,
      data: {
        student: {
          id: student.id,
          name: student.name,
          email: student.email,
          slug: student.slug,
          grade: student.grade,
          maxDevices: student.maxDevices,
        },
        devices: result.devices,
        activeCount: result.activeCount,
        maxDevices: result.maxDevices,
      },
    });
  } catch (error) {
    return handleControllerError(res, error, 'Failed to retrieve student devices.');
  }
}

/**
 * DELETE /admin/users/:userSlug/devices/:deviceIdentifier
 * Unbinds a single device for a given student (Admin only).
 */
async function unbindDeviceAdmin(req, res) {
  try {
    const student = await findUserBySlugOrId(req.params.userSlug);
    if (!student) {
      return res.status(404).json({ success: false, error: 'User not found.', code: 'USER_NOT_FOUND' });
    }

    const result = await deviceService.unbindDevice(req, student.id, req.params.deviceIdentifier);
    return res.json(result);
  } catch (error) {
    return handleControllerError(res, error, 'Failed to unbind student device.');
  }
}

/**
 * POST /admin/users/:userSlug/devices/reset
 * Resets all active devices for a given student (Admin only).
 */
async function resetStudentDevicesAdmin(req, res) {
  try {
    const student = await findUserBySlugOrId(req.params.userSlug);
    if (!student) {
      return res.status(404).json({ success: false, error: 'User not found.', code: 'USER_NOT_FOUND' });
    }

    const result = await deviceService.resetAllDevices(req, student.id);
    return res.json(result);
  } catch (error) {
    return handleControllerError(res, error, 'Failed to reset student devices.');
  }
}

/**
 * PATCH /admin/users/:userSlug/device-limit
 * Updates custom device limit for a given student (Admin only).
 */
async function updateStudentDeviceLimitAdmin(req, res) {
  try {
    const student = await findUserBySlugOrId(req.params.userSlug);
    if (!student) {
      return res.status(404).json({ success: false, error: 'User not found.', code: 'USER_NOT_FOUND' });
    }

    const result = await deviceService.updateDeviceLimit(req, student.id, req.body.maxDevices);
    return res.json({ success: true, data: { maxDevices: result.maxDevices } });
  } catch (error) {
    return handleControllerError(res, error, 'Failed to update student device limit.');
  }
}

module.exports = {
  getMyDevices,
  getStudentDevicesAdmin,
  unbindDeviceAdmin,
  resetStudentDevicesAdmin,
  updateStudentDeviceLimitAdmin,
};
