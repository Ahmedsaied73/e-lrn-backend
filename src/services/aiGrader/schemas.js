'use strict';

/**
 * schemas.js — verdict contract for the AI grader.
 *
 * FR-12: Reject, never clamp. Any out-of-range score, maxScore mismatch, or
 * invalid confidence throws SCALE_MISMATCH so the worker routes it to
 * NEEDS_REVIEW(SCALE_MISMATCH) instead of silently awarding wrong marks.
 */

const { z } = require('zod');

const RawVerdictSchema = z.object({
  score: z.number(),
  maxScore: z.number(),
  confidence: z.number(),
  feedback: z.string(),
  reasoning: z.string().optional(),
});

const CriterionVerdictSchema = z.object({
  id: z.string(),
  awarded: z.number(),
  evidence: z.string().optional(),
});

const StructuredVerdictSchema = z.object({
  criteria: z.array(CriterionVerdictSchema),
  maxScore: z.number(),
  confidence: z.number(),
  feedback: z.string(),
  reasoning: z.string().optional(),
});

const MAX_FEEDBACK_CHARS = 2000;
const MAX_REASONING_CHARS = 2000;

function scaleMismatch(message) {
  return Object.assign(new Error(`SCALE_MISMATCH: ${message}`), { code: 'SCALE_MISMATCH' });
}

/**
 * Validate a raw model verdict against server-side bounds.
 * Throws SCALE_MISMATCH on any out-of-range value (never clamps).
 */
function validateVerdict(raw, maxPoints) {
  const parsed = RawVerdictSchema.parse(raw);

  if (parsed.maxScore !== maxPoints) {
    throw scaleMismatch(`model maxScore ${parsed.maxScore} != server ${maxPoints}`);
  }
  if (!Number.isFinite(parsed.score) || parsed.score < 0 || parsed.score > maxPoints) {
    throw scaleMismatch(`score ${parsed.score} outside [0, ${maxPoints}]`);
  }
  if (!Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) {
    throw scaleMismatch(`confidence ${parsed.confidence} outside [0, 1]`);
  }

  const feedback = parsed.feedback.trim().slice(0, MAX_FEEDBACK_CHARS);
  if (!feedback) {
    throw new Error('AI verdict has empty feedback');
  }

  return {
    score: parsed.score,
    maxScore: maxPoints,
    budgetOverridden: false,
    confidence: parsed.confidence,
    feedback,
    reasoning: typeof parsed.reasoning === 'string'
      ? parsed.reasoning.trim().slice(0, MAX_REASONING_CHARS) || null
      : null,
  };
}

/**
 * FR-13: Validate a structured-rubric verdict.
 * Server sums awarded points across criteria; any criterion whose evidence is
 * not found verbatim in studentAnswer (when awarded > 0) is zeroed.
 */
function validateStructuredVerdict(raw, rubricCriteria, maxPoints, studentAnswer) {
  const parsed = StructuredVerdictSchema.parse(raw);

  if (parsed.maxScore !== maxPoints) {
    throw scaleMismatch(`model maxScore ${parsed.maxScore} != server ${maxPoints}`);
  }
  if (!Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) {
    throw scaleMismatch(`confidence ${parsed.confidence} outside [0, 1]`);
  }

  const feedback = parsed.feedback.trim().slice(0, MAX_FEEDBACK_CHARS);
  if (!feedback) {
    throw new Error('AI verdict has empty feedback');
  }

  const normalizedStudent = typeof studentAnswer === 'string' ? studentAnswer : '';
  const criteriaMap = new Map(parsed.criteria.map((c) => [c.id, c]));
  const breakdown = [];
  let totalScore = 0;

  for (const spec of rubricCriteria) {
    const item = criteriaMap.get(spec.id);
    if (!item) {
      breakdown.push({ id: spec.id, awarded: 0, max: spec.points, evidence: null, reason: 'missing_from_output' });
      continue;
    }
    if (!Number.isFinite(item.awarded) || item.awarded < 0 || item.awarded > spec.points) {
      throw scaleMismatch(`criterion "${spec.id}" awarded ${item.awarded} outside [0, ${spec.points}]`);
    }
    const evidence = typeof item.evidence === 'string' ? item.evidence.trim() : '';
    let awarded = item.awarded;
    if (awarded > 0 && (!evidence || !normalizedStudent.includes(evidence))) {
      awarded = 0;
    }
    totalScore += awarded;
    breakdown.push({ id: spec.id, awarded, max: spec.points, evidence: evidence || null });
  }

  if (totalScore < 0 || totalScore > maxPoints) {
    throw scaleMismatch(`summed criteria score ${totalScore} outside [0, ${maxPoints}]`);
  }

  return {
    score: totalScore,
    maxScore: maxPoints,
    budgetOverridden: false,
    confidence: parsed.confidence,
    feedback,
    reasoning: typeof parsed.reasoning === 'string'
      ? parsed.reasoning.trim().slice(0, MAX_REASONING_CHARS) || null
      : null,
    criteriaBreakdown: breakdown,
  };
}

module.exports = {
  RawVerdictSchema,
  StructuredVerdictSchema,
  validateVerdict,
  validateStructuredVerdict,
  MAX_FEEDBACK_CHARS,
};
