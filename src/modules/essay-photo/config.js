'use strict';

const env = require('../../config/env');

const essayPhotoConfig = env.essayPhoto || {};

const COST_RATES_PER_1M = Object.freeze({
  'gemini-3.1-flash-lite': { input: 0.075, output: 0.30, thinking: 0.30 },
  'gemini-3.5-flash-lite': { input: 0.10, output: 0.40, thinking: 0.40 },
  'gemini-3.8-flash': { input: 0.15, output: 0.60, thinking: 0.60 },
  default: { input: 0.10, output: 0.40, thinking: 0.40 },
});

function estimateCostUsd(modelId, inputTokens = 0, outputTokens = 0, thinkingTokens = 0) {
  const rates = COST_RATES_PER_1M[modelId] || COST_RATES_PER_1M.default;
  const cost =
    (inputTokens * rates.input +
      outputTokens * rates.output +
      thinkingTokens * rates.thinking) /
    1_000_000;
  return Number(cost.toFixed(6));
}

module.exports = {
  ...essayPhotoConfig,
  MAX_IMAGE_BYTES: 4 * 1024 * 1024,
  MAX_INPUT_PIXELS: 25_000_000,
  MAX_DIMENSION: 1600,
  JPEG_QUALITY: 82,
  BURST_LIMIT: 3,
  BURST_WINDOW_SEC: 30,
  DEDUP_TTL_SEC: 600,
  COST_RATES_PER_1M,
  estimateCostUsd,
};
