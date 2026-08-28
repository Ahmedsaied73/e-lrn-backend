'use strict';
/**
 * scripts/testQuizLogic.js
 * Self-contained assert-based test for quizService pure functions.
 * No test framework — consistent with repo conventions.
 * Run: node scripts/testQuizLogic.js
 */
const assert = require('assert');
const {
  validateSurveyJson,
  buildAnswerKey,
  sanitizeForStudent,
  gradeMcq,
  computeTotalPoints,
  computeScorePercent,
} = require('../src/services/quizService');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌  ${name}`);
    console.error(`      ${err.message}`);
    failed++;
  }
}

// ─── validateSurveyJson ───────────────────────────────────────────────────────
console.log('\n── validateSurveyJson ──');

test('Valid survey passes', () => {
  const json = {
    pages: [{ elements: [{ type: 'radiogroup', name: 'q1', title: 'Which?', choices: ['A', 'B'] }] }],
  };
  const result = validateSurveyJson(json);
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
});

test('Missing pages fails', () => {
  const result = validateSurveyJson({ notPages: [] });
  assert.strictEqual(result.ok, false);
});

test('Disallowed type fails', () => {
  const json = {
    pages: [{ elements: [{ type: 'matrix', name: 'q1' }] }],
  };
  const result = validateSurveyJson(json);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some(e => e.includes('matrix')));
});

test('Duplicate names fail', () => {
  const json = {
    pages: [{ elements: [{ type: 'radiogroup', name: 'q1' }, { type: 'comment', name: 'q1' }] }],
  };
  const result = validateSurveyJson(json);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some(e => e.includes('Duplicate')));
});

test('Survey exceeding max size fails', () => {
  const bigText = 'x'.repeat(270000);
  const json = { pages: [{ elements: [{ type: 'radiogroup', name: 'q1', title: bigText }] }] };
  const result = validateSurveyJson(json);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some(e => e.includes('size')));
});

// ─── buildAnswerKey ───────────────────────────────────────────────────────────
console.log('\n── buildAnswerKey ──');

const goodSurvey = {
  pages: [{ elements: [
    { type: 'radiogroup', name: 'q1', title: 'Q1', choices: ['A', 'B'] },
    { type: 'comment',    name: 'q2', title: 'Explain' },
  ]}],
};
const goodKeyInput = {
  q1: { type: 'radiogroup', correctValue: 'A', points: 2 },
  q2: { type: 'comment', modelAnswer: 'Because X', points: 3 },
};

test('Valid answer key builds correctly', () => {
  const { ok, answerKey, errors } = buildAnswerKey(goodSurvey, goodKeyInput);
  assert.strictEqual(ok, true, JSON.stringify(errors));
  assert.strictEqual(answerKey.q1.correctValue, 'A');
  assert.strictEqual(answerKey.q2.modelAnswer, 'Because X');
});

test('Missing key entry fails', () => {
  const { ok, errors } = buildAnswerKey(goodSurvey, { q1: { type: 'radiogroup', correctValue: 'A', points: 2 } });
  assert.strictEqual(ok, false);
  assert.ok(errors.some(e => e.includes('q2')));
});

test('MCQ missing correctValue fails', () => {
  const { ok, errors } = buildAnswerKey(goodSurvey, {
    q1: { type: 'radiogroup', correctValue: '', points: 2 },
    q2: { type: 'comment', modelAnswer: 'X', points: 3 },
  });
  assert.strictEqual(ok, false);
  assert.ok(errors.some(e => e.includes('correctValue')));
});

test('Zero points fails', () => {
  const { ok, errors } = buildAnswerKey(goodSurvey, {
    q1: { type: 'radiogroup', correctValue: 'A', points: 0 },
    q2: { type: 'comment', modelAnswer: 'X', points: 3 },
  });
  assert.strictEqual(ok, false);
});

// ─── sanitizeForStudent ───────────────────────────────────────────────────────
console.log('\n── sanitizeForStudent ──');

test('answerKey is stripped', () => {
  const quiz = { id: 1, videoId: 2, title: 'T', timeLimitSec: 300, passingScore: 50, surveyJson: {}, answerKey: { q1: { correctValue: 'A' } } };
  const safe = sanitizeForStudent(quiz);
  assert.strictEqual(safe.answerKey, undefined);
  assert.strictEqual(safe.surveyJson instanceof Object, true);
});

// ─── gradeMcq ─────────────────────────────────────────────────────────────────
console.log('\n── gradeMcq ──');

const answerKey = {
  q1: { type: 'radiogroup', correctValue: 'A', points: 2 },
  q2: { type: 'radiogroup', correctValue: 'B', points: 3 },
  q3: { type: 'comment',    correctValue: null, points: 5 },
};

test('All MCQs correct → full MCQ points', () => {
  const { mcqEarned, totalMcqPoints } = gradeMcq(answerKey, { q1: 'A', q2: 'B', q3: 'any' });
  assert.strictEqual(mcqEarned, 5);
  assert.strictEqual(totalMcqPoints, 5);
});

test('All MCQs wrong → 0 points', () => {
  const { mcqEarned } = gradeMcq(answerKey, { q1: 'B', q2: 'A' });
  assert.strictEqual(mcqEarned, 0);
});

test('Partial MCQ → correct partial', () => {
  const { mcqEarned } = gradeMcq(answerKey, { q1: 'A', q2: 'A' });
  assert.strictEqual(mcqEarned, 2);
});

test('Missing answer treated as wrong', () => {
  const { mcqEarned } = gradeMcq(answerKey, {});
  assert.strictEqual(mcqEarned, 0);
});

// ─── computeScorePercent ──────────────────────────────────────────────────────
console.log('\n── computeScorePercent ──');

test('5/10 = 50%', () => assert.strictEqual(computeScorePercent(5, 10), 50));
test('0/10 = 0%', () => assert.strictEqual(computeScorePercent(0, 10), 0));
test('10/10 = 100%', () => assert.strictEqual(computeScorePercent(10, 10), 100));
test('Zero total = 0% (no division by zero)', () => assert.strictEqual(computeScorePercent(5, 0), 0));
test('7/11 rounds correctly', () => assert.strictEqual(computeScorePercent(7, 11), 63.64));

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n═══════════════════════════════`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('  Some tests FAILED');
  process.exit(1);
} else {
  console.log('  All quiz logic tests passed ✅');
}
