'use strict';

const accessCodeService = require('../services/accessCodes/accessCodeService');

/**
 * Handles errors and maps them to structured JSON responses.
 */
function handleControllerError(res, err) {
  if (err && err.statusCode && err.code) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code,
    });
  }

  console.error('[AccessCodeController] Unexpected error:', err);
  return res.status(500).json({
    success: false,
    error: 'An internal server error occurred.',
    code: 'INTERNAL_SERVER_ERROR',
  });
}

/**
 * POST /access-codes/generate (Admin)
 */
async function generateBatch(req, res) {
  try {
    const { courseId, quantity, codeLength, label, tags } = req.body || {};
    const adminId = req.user.id;

    const data = await accessCodeService.generateBatch({
      courseId,
      quantity,
      codeLength,
      label,
      tags,
      adminId,
    });

    return res.status(201).json({
      success: true,
      data,
    });
  } catch (err) {
    return handleControllerError(res, err);
  }
}

/**
 * GET /access-codes/batches (Admin)
 */
async function getBatches(req, res) {
  try {
    const { courseId, search, page, limit } = req.query || {};
    const data = await accessCodeService.getBatches({
      courseId,
      search,
      page,
      limit,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
    return handleControllerError(res, err);
  }
}

/**
 * GET /access-codes/batches/:id (Admin)
 */
async function getBatchDetails(req, res) {
  try {
    const batchId = req.params.id;
    const { status, search, page, limit } = req.query || {};

    const data = await accessCodeService.getBatchDetails({
      batchId,
      status,
      search,
      page,
      limit,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
    return handleControllerError(res, err);
  }
}

/**
 * GET /access-codes/batches/:id/download (Admin)
 */
async function downloadBatchCsv(req, res) {
  try {
    const batchId = req.params.id;
    const { filename, csvContent } = await accessCodeService.getBatchCsv(batchId);

    const asciiFilename = filename.replace(/[^\x20-\x7E]/g, '_');
    const utf8Filename = encodeURIComponent(filename);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFilename}"; filename*=UTF-8''${utf8Filename}`
    );

    return res.send(csvContent);
  } catch (err) {
    return handleControllerError(res, err);
  }
}

/**
 * POST /access-codes/revoke (Admin)
 */
async function revokeCode(req, res) {
  try {
    const { codeIds } = req.body || {};
    const adminId = req.user.id;

    const data = await accessCodeService.revokeCode({
      codeIds,
      adminId,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
    return handleControllerError(res, err);
  }
}

/**
 * POST /access-codes/revoke-batch (Admin)
 */
async function revokeBatch(req, res) {
  try {
    const { batchId } = req.body || {};
    const adminId = req.user.id;

    const data = await accessCodeService.revokeBatch({
      batchId,
      adminId,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
    return handleControllerError(res, err);
  }
}

/**
 * GET /access-codes/lookup/:code (Admin)
 */
async function lookupCode(req, res) {
  try {
    const rawCode = req.params.code;
    const data = await accessCodeService.lookupCode(rawCode);

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
    return handleControllerError(res, err);
  }
}

/**
 * POST /access-codes/redeem (Student)
 */
async function redeemCode(req, res) {
  try {
    const { code } = req.body || {};
    const userId = req.user.id;

    const data = await accessCodeService.redeemCode({
      userId,
      code,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
    return handleControllerError(res, err);
  }
}

module.exports = {
  generateBatch,
  getBatches,
  getBatchDetails,
  downloadBatchCsv,
  revokeCode,
  revokeBatch,
  lookupCode,
  redeemCode,
};
