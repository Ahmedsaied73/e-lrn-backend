'use strict';

/**
 * handwritingController.js — Controller shell for handwriting recognition.
 *
 * Implements Plan §8.1:
 * - Feature flag gate: returns 404 when HANDWRITING_ENABLED is false.
 * - Authenticated student endpoint.
 * - Stroke validation (arrays aligned, < 80 strokes, < 6,000 points, finite coordinates, < 100 KB).
 * - Daily budget check (max conversions per day, hard stop).
 * - Safe recognition via HandwritingRecognizer interface.
 */

const { validateStrokes, MAX_BODY_BYTES } = require('../services/handwriting/validateStrokes');
const { HandwritingRecognizer } = require('../services/handwriting/recognizer');
const { checkAndIncrementBudget } = require('../services/handwriting/budgetTracker');
const config = require('../config/env');

function isHandwritingEnabled() {
  if (process.env.HANDWRITING_ENABLED !== undefined) {
    return ['true', '1', 'yes', 'on'].includes(String(process.env.HANDWRITING_ENABLED).trim().toLowerCase());
  }
  return Boolean(config.handwriting && config.handwriting.enabled);
}

async function recognizeHandwriting(req, res) {
  // 1. Feature Flag Check — returns 404 when disabled
  if (!isHandwritingEnabled()) {
    return res.status(404).json({
      error: 'Handwriting recognition is disabled',
      code: 'HANDWRITING_DISABLED',
    });
  }

  // 2. Body size check (under 100 KB)
  const bodyLength = req.headers['content-length']
    ? parseInt(req.headers['content-length'], 10)
    : Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8');

  if (bodyLength > MAX_BODY_BYTES) {
    return res.status(400).json({
      error: `Payload size (${Math.round(bodyLength / 1024)} KB) exceeds 100 KB limit`,
      code: 'STROKES_TOO_LARGE',
    });
  }

  // 3. Stroke validation
  const validation = validateStrokes(req.body);
  if (!validation.ok) {
    return res.status(400).json({
      error: validation.error,
      code: validation.code,
    });
  }

  // 4. Daily budget cap check
  const budget = await checkAndIncrementBudget(config.handwriting.dailyBudget);
  if (!budget.allowed) {
    return res.status(429).json({
      error: 'Daily handwriting budget exceeded',
      code: 'DAILY_BUDGET_EXCEEDED',
      maxDaily: budget.maxDaily,
    });
  }

  // 5. Recognition through provider interface (mock provider)
  try {
    const result = await HandwritingRecognizer.recognize(req.body.strokes);
    return res.status(200).json({
      success: true,
      latex: result.latex,
    });
  } catch (_err) {
    return res.status(500).json({
      error: 'Failed to recognize handwriting',
      code: 'RECOGNITION_ERROR',
      latex: null,
    });
  }
}

module.exports = {
  recognizeHandwriting,
  isHandwritingEnabled,
};
