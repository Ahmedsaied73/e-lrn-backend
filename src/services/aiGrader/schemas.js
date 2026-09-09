'use strict';

/**
 * schemas.js — verdict contract for the AI grader.
 *
 * The model proposes; the server disposes. Every field is re-validated here:
 * - score is clamped to [0, maxPoints] (the model never sets the budget —
 *   maxPoints always comes from the quiz answerKey, maxScore in the verdict
 *   is informational and overridden on mismatch).
 * - confidence gates auto-finalize downstream (threshold lives in worker.js).
 * - feedback length is bounded so student-facing text can't balloon.
 */

const { z } = require('zod');

const RawVerdictSchema = z.object({
  score: z.number(),
  maxScore: z.number(),
  confidence: z.number(),
  feedback: z.string(),
  reasoning: z.string().optional(),
});

const MAX_FEEDBACK_CHARS = 2000;
const MAX_REASONING_CHARS = 2000;

function clampNumber(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Validate + normalize a raw model verdict against server-side bounds.
 * Throws on structural failure (caller retries or escalates to human).
 * Never throws on value drift — clamps instead (a clumsy number is still signal).
 */
function validateVerdict(raw, maxPoints) {
  const parsed = RawVerdictSchema.parse(raw);
  const feedback = parsed.feedback.trim().slice(0, MAX_FEEDBACK_CHARS);
  if (!feedback) {
    throw new Error('AI verdict has empty feedback');
  }
  return {
    score: clampNumber(parsed.score, 0, maxPoints),
    maxScore: maxPoints,
    budgetOverridden: parsed.maxScore !== maxPoints,
    confidence: clampNumber(parsed.confidence, 0, 1),
    feedback,
    reasoning: typeof parsed.reasoning === 'string'
      ? parsed.reasoning.trim().slice(0, MAX_REASONING_CHARS) || null
      : null,
  };
}

module.exports = {
  RawVerdictSchema,
  validateVerdict,
  MAX_FEEDBACK_CHARS,
};
