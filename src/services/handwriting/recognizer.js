'use strict';

/**
 * recognizer.js — Handwriting Recognizer Provider Interface & Mock Implementation.
 *
 * Implements Plan §8.1:
 * - Provider interface: HandwritingRecognizer.recognize(strokes): Promise<{ latex: string | null }>
 * - Default mock provider: returns recognized LaTeX for valid strokes without calling paid external services.
 * - 8-second timeout enforcement.
 * - Recognized output is processed through normalizeMathLatex and KaTeX parse check.
 * - An invalid KaTeX result or provider timeout safely returns { latex: null }.
 */

const katex = require('katex');
const { normalizeMathLatex } = require('../../lib/richContent/normalize');
const config = require('../../config/env');

const DEFAULT_TIMEOUT_MS = 8000; // 8 seconds per Plan §8.1

class HandwritingRecognizer {
  /**
   * Recognize math handwriting strokes into LaTeX.
   *
   * @param {object} strokes - { x: number[][], y: number[][], t?: number[][] }
   * @param {object} [options]
   * @param {string} [options.provider] - 'mock' (default) or future providers
   * @param {string} [options.mockLatex] - Optional override LaTeX for tests
   * @param {boolean} [options.mockFail] - Force mock failure for testing
   * @param {number} [options.timeoutMs] - Request timeout in ms (default 8000)
   * @returns {Promise<{ latex: string | null, error?: string }>}
   */
  static async recognize(strokes, options = {}) {
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const provider = options.provider || config.handwriting.provider || 'mock';

    let timeoutId;
    const timeoutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        resolve({ timeout: true });
      }, timeoutMs);
    });

    try {
      const recognitionPromise = (async () => {
        if (provider === 'mock') {
          return HandwritingRecognizer._mockRecognize(strokes, options);
        }
        // Future provider implementations (e.g. Mathpix strokes API once approved by product owner)
        // Credentials stay strictly server-side.
        return { latex: null, error: 'PROVIDER_NOT_CONFIGURED' };
      })();

      const raceResult = await Promise.race([recognitionPromise, timeoutPromise]);
      clearTimeout(timeoutId);

      if (raceResult && raceResult.timeout) {
        return { latex: null, error: 'TIMEOUT' };
      }

      if (!raceResult || !raceResult.latex) {
        return { latex: null, error: raceResult ? raceResult.error : 'NO_OUTPUT' };
      }

      // Step 1: Normalize LaTeX (replace \placeholder with {}, trim)
      const normalized = normalizeMathLatex(raceResult.latex);
      if (!normalized) {
        return { latex: null, error: 'EMPTY_NORMALIZED_OUTPUT' };
      }

      // Step 2: KaTeX parse check
      try {
        katex.renderToString(normalized, {
          throwOnError: true,
          trust: false,
          strict: 'ignore',
          maxExpand: 1000,
        });
        return { latex: normalized };
      } catch (_katexErr) {
        return { latex: null, error: 'INVALID_KATEX_OUTPUT' };
      }
    } catch (err) {
      clearTimeout(timeoutId);
      return { latex: null, error: err.message || 'RECOGNITION_ERROR' };
    }
  }

  /**
   * Internal mock provider implementation.
   */
  static async _mockRecognize(strokes, options = {}) {
    if (options.mockFail) {
      return { latex: null, error: 'MOCK_FAILURE' };
    }

    if (options.mockDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.mockDelayMs));
    }

    if (options.mockLatex !== undefined) {
      return { latex: options.mockLatex };
    }

    // Default mock response: generate realistic LaTeX based on stroke count
    if (!strokes || !strokes.x || strokes.x.length === 0) {
      return { latex: null, error: 'EMPTY_STROKES' };
    }

    const strokeCount = strokes.x.length;
    let mockLatex = 'x^{2} + y^{2} = r^{2}';
    if (strokeCount === 1) {
      mockLatex = 'x';
    } else if (strokeCount === 2) {
      mockLatex = 'x + y';
    } else if (strokeCount === 3) {
      mockLatex = '\\frac{a}{b}';
    } else if (strokeCount > 10) {
      mockLatex = '\\int_{0}^{1} x^{2} \\, dx = \\frac{1}{3}';
    }

    return { latex: mockLatex };
  }
}

module.exports = {
  HandwritingRecognizer,
  DEFAULT_TIMEOUT_MS,
};
