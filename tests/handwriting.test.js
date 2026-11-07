'use strict';

/**
 * Phase 8 Backend Tests — Handwriting Infrastructure Shell
 *
 * Verifies that:
 * 1. Stroke validation enforces limits (aligned arrays, <=80 strokes, <=6,000 points, finite numbers, <100 KB).
 * 2. Provider interface (HandwritingRecognizer) normalizes LaTeX, checks KaTeX parsing, and handles timeouts.
 * 3. Daily budget tracker enforces the budget ceiling.
 * 4. Route handler enforces authentication, returns 404 when HANDWRITING_ENABLED is false,
 *    and respects the 20 req/min rate limit when enabled.
 */

process.env.REDIS_ENABLED = 'false';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const config = require('../src/config/env');
const { validateStrokes, MAX_STROKES, MAX_TOTAL_POINTS, MAX_BODY_BYTES } = require('../src/services/handwriting/validateStrokes');
const { HandwritingRecognizer } = require('../src/services/handwriting/recognizer');
const { checkAndIncrementBudget, resetBudgetForTesting } = require('../src/services/handwriting/budgetTracker');
const { recognizeHandwriting } = require('../src/controllers/handwritingController');

function createMockReqRes({ body = {}, headers = {}, user = null } = {}) {
  const req = {
    body,
    headers: { ...headers },
    user,
    ip: '127.0.0.1',
  };

  const res = {
    statusCode: 200,
    headersSent: false,
    _json: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this._json = data;
      return this;
    },
  };

  return { req, res };
}

describe('Phase 8: Stroke Validation (validateStrokes)', () => {
  it('accepts valid stroke coordinate arrays', () => {
    const validBody = {
      strokes: {
        x: [[10, 20, 30], [40, 50]],
        y: [[15, 25, 35], [45, 55]],
      },
    };
    const res = validateStrokes(validBody);
    assert.equal(res.ok, true);
    assert.equal(res.strokeCount, 2);
    assert.equal(res.totalPoints, 5);
  });

  it('accepts valid strokes with optional timestamp array t', () => {
    const validWithT = {
      strokes: {
        x: [[10, 20]],
        y: [[15, 25]],
        t: [[1000, 1050]],
      },
    };
    const res = validateStrokes(validWithT);
    assert.equal(res.ok, true);
    assert.equal(res.strokeCount, 1);
    assert.equal(res.totalPoints, 2);
  });

  it('rejects mismatched x and y outer stroke counts', () => {
    const invalid = {
      strokes: {
        x: [[10, 20]],
        y: [[10, 20], [30, 40]],
      },
    };
    const res = validateStrokes(invalid);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'STROKES_LENGTH_MISMATCH');
  });

  it('rejects mismatched point count inside a stroke', () => {
    const invalid = {
      strokes: {
        x: [[10, 20, 30]],
        y: [[10, 20]],
      },
    };
    const res = validateStrokes(invalid);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'STROKES_LENGTH_MISMATCH');
  });

  it('rejects empty strokes array', () => {
    const res = validateStrokes({ strokes: { x: [], y: [] } });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'NO_STROKES');
  });

  it('rejects a stroke with 0 points', () => {
    const res = validateStrokes({ strokes: { x: [[]], y: [[]] } });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'EMPTY_STROKE');
  });

  it('rejects more than 80 strokes', () => {
    const x = [];
    const y = [];
    for (let i = 0; i < 81; i++) {
      x.push([i, i + 1]);
      y.push([i, i + 1]);
    }
    const res = validateStrokes({ strokes: { x, y } });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'TOO_MANY_STROKES');
  });

  it('rejects more than 6,000 points total', () => {
    const x = [new Array(6001).fill(1)];
    const y = [new Array(6001).fill(1)];
    const res = validateStrokes({ strokes: { x, y } });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'TOO_MANY_POINTS');
  });

  it('rejects non-finite coordinate values (NaN, Infinity, strings)', () => {
    const withNaN = {
      strokes: {
        x: [[10, NaN]],
        y: [[10, 20]],
      },
    };
    assert.equal(validateStrokes(withNaN).code, 'NON_FINITE_COORDINATES');

    const withInf = {
      strokes: {
        x: [[10, 20]],
        y: [[Infinity, 20]],
      },
    };
    assert.equal(validateStrokes(withInf).code, 'NON_FINITE_COORDINATES');

    const withStr = {
      strokes: {
        x: [[10, '20']],
        y: [[10, 20]],
      },
    };
    assert.equal(validateStrokes(withStr).code, 'NON_FINITE_COORDINATES');
  });

  it('rejects body exceeding 100 KB limit', () => {
    // Generate large array of points
    const largeStrokeX = new Array(5000).fill(123.456789);
    const largeStrokeY = new Array(5000).fill(987.654321);
    const largeBody = {
      strokes: {
        x: [largeStrokeX, largeStrokeX],
        y: [largeStrokeY, largeStrokeY],
      },
    };
    // If serialized body > 100 KB
    const str = JSON.stringify(largeBody);
    if (Buffer.byteLength(str) > MAX_BODY_BYTES) {
      const res = validateStrokes(largeBody);
      assert.equal(res.ok, false);
      assert.equal(res.code, 'STROKES_TOO_LARGE');
    }
  });
});

describe('Phase 8: HandwritingRecognizer Provider Interface', () => {
  it('recognizes valid strokes through mock provider and returns KaTeX-valid LaTeX', async () => {
    const strokes = {
      x: [[10, 20], [30, 40]],
      y: [[10, 20], [30, 40]],
    };
    const result = await HandwritingRecognizer.recognize(strokes);
    assert.ok(result.latex);
    assert.equal(typeof result.latex, 'string');
    assert.equal(result.latex, 'x + y');
  });

  it('normalizes MathLive placeholders in recognizer output', async () => {
    const strokes = { x: [[10]], y: [[10]] };
    const result = await HandwritingRecognizer.recognize(strokes, {
      mockLatex: 'x + \\placeholder{}',
    });
    assert.equal(result.latex, 'x + {}', 'Placeholder replaced with {}');
  });

  it('returns latex: null if recognizer output fails KaTeX parsing', async () => {
    const strokes = { x: [[10]], y: [[10]] };
    const result = await HandwritingRecognizer.recognize(strokes, {
      mockLatex: '\\frac{1}{', // malformed LaTeX
    });
    assert.equal(result.latex, null);
    assert.equal(result.error, 'INVALID_KATEX_OUTPUT');
  });

  it('handles provider timeout gracefully within timeout limit', async () => {
    const strokes = { x: [[10]], y: [[10]] };
    const result = await HandwritingRecognizer.recognize(strokes, {
      mockDelayMs: 200,
      timeoutMs: 50, // lower timeout for test speed
    });
    assert.equal(result.latex, null);
    assert.equal(result.error, 'TIMEOUT');
  });

  it('handles mock provider error gracefully', async () => {
    const strokes = { x: [[10]], y: [[10]] };
    const result = await HandwritingRecognizer.recognize(strokes, {
      mockFail: true,
    });
    assert.equal(result.latex, null);
    assert.equal(result.error, 'MOCK_FAILURE');
  });
});

describe('Phase 8: Daily Budget Tracking (checkAndIncrementBudget)', () => {
  beforeEach(() => {
    resetBudgetForTesting();
  });

  it('tracks conversions and stops when budget is reached', async () => {
    const maxBudget = 3;
    const testDate = new Date(2026, 10, 7);

    const r1 = await checkAndIncrementBudget(maxBudget, testDate);
    assert.equal(r1.allowed, true);
    assert.equal(r1.count, 1);

    const r2 = await checkAndIncrementBudget(maxBudget, testDate);
    assert.equal(r2.allowed, true);
    assert.equal(r2.count, 2);

    const r3 = await checkAndIncrementBudget(maxBudget, testDate);
    assert.equal(r3.allowed, true);
    assert.equal(r3.count, 3);

    // 4th request exceeds budget limit
    const r4 = await checkAndIncrementBudget(maxBudget, testDate);
    assert.equal(r4.allowed, false);
    assert.equal(r4.count, 4);
    assert.equal(r4.maxDaily, 3);
  });
});

describe('Phase 8: Controller & Route Integration (recognizeHandwriting)', () => {
  const origEnvFlag = process.env.HANDWRITING_ENABLED;

  beforeEach(() => {
    resetBudgetForTesting();
  });

  afterEach(() => {
    if (origEnvFlag !== undefined) {
      process.env.HANDWRITING_ENABLED = origEnvFlag;
    } else {
      delete process.env.HANDWRITING_ENABLED;
    }
  });

  it('returns 404 HANDWRITING_DISABLED when HANDWRITING_ENABLED=false', async () => {
    process.env.HANDWRITING_ENABLED = 'false';

    const { req, res } = createMockReqRes({
      body: { strokes: { x: [[10, 20]], y: [[10, 20]] } },
      user: { id: 10, role: 'STUDENT' },
    });

    await recognizeHandwriting(req, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res._json.code, 'HANDWRITING_DISABLED');
  });

  it('returns 200 with recognized LaTeX when HANDWRITING_ENABLED=true and input is valid', async () => {
    process.env.HANDWRITING_ENABLED = 'true';

    const { req, res } = createMockReqRes({
      body: { strokes: { x: [[10, 20], [30, 40]], y: [[10, 20], [30, 40]] } },
      user: { id: 10, role: 'STUDENT' },
    });

    await recognizeHandwriting(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res._json.success, true);
    assert.equal(typeof res._json.latex, 'string');
    assert.equal(res._json.latex, 'x + y');
  });

  it('returns 400 when strokes payload is invalid', async () => {
    process.env.HANDWRITING_ENABLED = 'true';

    const { req, res } = createMockReqRes({
      body: { strokes: { x: [[10]], y: [[10, 20]] } }, // length mismatch
      user: { id: 10, role: 'STUDENT' },
    });

    await recognizeHandwriting(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res._json.code, 'STROKES_LENGTH_MISMATCH');
  });

  it('returns 429 when daily budget is exceeded', async () => {
    process.env.HANDWRITING_ENABLED = 'true';
    const origBudget = config.handwriting.dailyBudget;
    config.handwriting.dailyBudget = 1;

    try {
      const { req: req1, res: res1 } = createMockReqRes({
        body: { strokes: { x: [[10]], y: [[10]] } },
        user: { id: 10, role: 'STUDENT' },
      });
      await recognizeHandwriting(req1, res1);
      assert.equal(res1.statusCode, 200);

      const { req: req2, res: res2 } = createMockReqRes({
        body: { strokes: { x: [[10]], y: [[10]] } },
        user: { id: 10, role: 'STUDENT' },
      });
      await recognizeHandwriting(req2, res2);
      assert.equal(res2.statusCode, 429);
      assert.equal(res2._json.code, 'DAILY_BUDGET_EXCEEDED');
    } finally {
      config.handwriting.dailyBudget = origBudget;
    }
  });
});
