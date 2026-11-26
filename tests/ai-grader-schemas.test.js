'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateVerdict, validateStructuredVerdict } = require('../src/services/aiGrader/schemas');

describe('aiGrader schemas (FR-12 & FR-13)', () => {
  it('accepts valid in-range verdict', () => {
    const v = validateVerdict({ score: 7.5, maxScore: 10, confidence: 0.9, feedback: 'Good answer.' }, 10);
    assert.equal(v.score, 7.5);
    assert.equal(v.maxScore, 10);
    assert.equal(v.confidence, 0.9);
  });

  it('rejects score > maxPoints with SCALE_MISMATCH instead of clamping', () => {
    assert.throws(
      () => validateVerdict({ score: 100, maxScore: 10, confidence: 1.0, feedback: 'Perfect' }, 10),
      (err) => err.code === 'SCALE_MISMATCH'
    );
  });

  it('rejects maxScore mismatch with SCALE_MISMATCH', () => {
    assert.throws(
      () => validateVerdict({ score: 5, maxScore: 20, confidence: 0.9, feedback: 'Ok' }, 10),
      (err) => err.code === 'SCALE_MISMATCH'
    );
  });

  it('rejects confidence > 1 with SCALE_MISMATCH', () => {
    assert.throws(
      () => validateVerdict({ score: 5, maxScore: 10, confidence: 5, feedback: 'Ok' }, 10),
      (err) => err.code === 'SCALE_MISMATCH'
    );
  });

  it('structured rubric sums awarded criteria and zeroes ungrounded evidence', () => {
    const rubric = [
      { id: 'c1', description: 'Mentions photosynthesis', points: 5 },
      { id: 'c2', description: 'Mentions chlorophyll', points: 5 },
    ];
    const studentAnswer = 'Plants use photosynthesis to make food.';
    const raw = {
      criteria: [
        { id: 'c1', awarded: 5, evidence: 'use photosynthesis' },
        { id: 'c2', awarded: 5, evidence: 'chlorophyll absorbs light' }, // not in studentAnswer!
      ],
      maxScore: 10,
      confidence: 0.95,
      feedback: 'Good explanation of photosynthesis.',
    };
    const v = validateStructuredVerdict(raw, rubric, 10, studentAnswer);
    assert.equal(v.score, 5);
    assert.equal(v.criteriaBreakdown[0].awarded, 5);
    assert.equal(v.criteriaBreakdown[1].awarded, 0);
  });
});
