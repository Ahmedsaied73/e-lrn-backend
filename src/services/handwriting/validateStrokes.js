'use strict';

/**
 * validateStrokes.js — Stroke format and limits validation for handwriting input.
 *
 * Implements Plan §8.1 & PRD §10:
 * - Body payload size check (< 100 KB)
 * - Structure check: { strokes: { x: number[][], y: number[][], t?: number[][] } }
 * - Array length alignment (x and y same length; t same length if present)
 * - Stroke count ceiling: at most 80 strokes
 * - Total points ceiling: at most 6,000 points across all strokes
 * - Coordinate finiteness: all numbers must be finite numbers
 */

const MAX_STROKES = 80;
const MAX_TOTAL_POINTS = 6000;
const MAX_BODY_BYTES = 100 * 1024; // 100 KB

function validateStrokes(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, code: 'INVALID_STROKES_FORMAT', error: 'Request body must be a JSON object' };
  }

  // Size validation
  const serialized = typeof body === 'string' ? body : JSON.stringify(body);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BODY_BYTES) {
    return { ok: false, code: 'STROKES_TOO_LARGE', error: `Payload exceeds max limit of ${MAX_BODY_BYTES / 1024} KB` };
  }

  const { strokes } = body;
  if (!strokes || typeof strokes !== 'object' || Array.isArray(strokes)) {
    return { ok: false, code: 'INVALID_STROKES_FORMAT', error: 'body.strokes must be an object with x and y arrays' };
  }

  const { x, y, t } = strokes;
  if (!Array.isArray(x) || !Array.isArray(y)) {
    return { ok: false, code: 'INVALID_STROKES_FORMAT', error: 'strokes.x and strokes.y must both be arrays' };
  }

  if (x.length !== y.length) {
    return {
      ok: false,
      code: 'STROKES_LENGTH_MISMATCH',
      error: `strokes.x length (${x.length}) does not match strokes.y length (${y.length})`,
    };
  }

  if (t !== undefined && t !== null) {
    if (!Array.isArray(t)) {
      return { ok: false, code: 'INVALID_STROKES_FORMAT', error: 'strokes.t must be an array if provided' };
    }
    if (t.length !== x.length) {
      return {
        ok: false,
        code: 'STROKES_LENGTH_MISMATCH',
        error: `strokes.t length (${t.length}) does not match strokes.x length (${x.length})`,
      };
    }
  }

  const strokeCount = x.length;
  if (strokeCount === 0) {
    return { ok: false, code: 'NO_STROKES', error: 'strokes array must contain at least one stroke' };
  }

  if (strokeCount > MAX_STROKES) {
    return {
      ok: false,
      code: 'TOO_MANY_STROKES',
      error: `Stroke count ${strokeCount} exceeds max limit of ${MAX_STROKES}`,
    };
  }

  let totalPoints = 0;

  for (let i = 0; i < strokeCount; i++) {
    const strokeX = x[i];
    const strokeY = y[i];

    if (!Array.isArray(strokeX) || !Array.isArray(strokeY)) {
      return {
        ok: false,
        code: 'INVALID_STROKES_FORMAT',
        error: `Stroke at index ${i} coordinates must be arrays`,
      };
    }

    if (strokeX.length !== strokeY.length) {
      return {
        ok: false,
        code: 'STROKES_LENGTH_MISMATCH',
        error: `Stroke ${i} x points (${strokeX.length}) does not match y points (${strokeY.length})`,
      };
    }

    if (strokeX.length === 0) {
      return {
        ok: false,
        code: 'EMPTY_STROKE',
        error: `Stroke at index ${i} has 0 points`,
      };
    }

    if (t && t[i]) {
      const strokeT = t[i];
      if (!Array.isArray(strokeT) || strokeT.length !== strokeX.length) {
        return {
          ok: false,
          code: 'STROKES_LENGTH_MISMATCH',
          error: `Stroke ${i} timestamp array length does not match points length`,
        };
      }
      for (let j = 0; j < strokeT.length; j++) {
        if (typeof strokeT[j] !== 'number' || !Number.isFinite(strokeT[j])) {
          return {
            ok: false,
            code: 'NON_FINITE_COORDINATES',
            error: `Non-finite timestamp value in stroke ${i} at point ${j}`,
          };
        }
      }
    }

    for (let j = 0; j < strokeX.length; j++) {
      const ptX = strokeX[j];
      const ptY = strokeY[j];

      if (typeof ptX !== 'number' || !Number.isFinite(ptX) || typeof ptY !== 'number' || !Number.isFinite(ptY)) {
        return {
          ok: false,
          code: 'NON_FINITE_COORDINATES',
          error: `Non-finite coordinate value in stroke ${i} at point ${j}`,
        };
      }
    }

    totalPoints += strokeX.length;
  }

  if (totalPoints > MAX_TOTAL_POINTS) {
    return {
      ok: false,
      code: 'TOO_MANY_POINTS',
      error: `Total point count ${totalPoints} exceeds max limit of ${MAX_TOTAL_POINTS}`,
    };
  }

  return {
    ok: true,
    strokeCount,
    totalPoints,
  };
}

module.exports = {
  validateStrokes,
  MAX_STROKES,
  MAX_TOTAL_POINTS,
  MAX_BODY_BYTES,
};
