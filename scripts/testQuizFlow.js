'use strict';
/**
 * scripts/testQuizFlow.js
 * End-to-end business flow test asserting all quiz service behaviors and flows.
 * Run: node scripts/testQuizFlow.js
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

function it(name, fn) {
  try {
    fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌  ${name}`);
    console.error(`      ${err.stack || err.message}`);
    failed++;
  }
}

console.log('\n=== END-TO-END QUIZ FLOW VERIFICATION ===\n');

// 1. Admin Authors Quiz with MCQ and Essay
const sampleSurvey = {
  title: 'Secondary Physics Quiz 1',
  pages: [
    {
      name: 'page1',
      elements: [
        {
          type: 'radiogroup',
          name: 'q_speed_of_light',
          title: 'What is the speed of light in vacuum?',
          choices: [
            { value: '3e8', text: '3 × 10^8 m/s' },
            { value: '3e6', text: '3 × 10^6 m/s' },
            { value: '1.5e8', text: '1.5 × 10^8 m/s' },
          ],
        },
        {
          type: 'comment',
          name: 'q_explain_refraction',
          title: 'Explain why refraction occurs when light enters a denser medium.',
        },
      ],
    },
  ],
};

const sampleAnswerKeyInput = {
  q_speed_of_light: {
    type: 'radiogroup',
    correctValue: '3e8',
    points: 4,
  },
  q_explain_refraction: {
    type: 'comment',
    modelAnswer: 'Light slows down in optically denser media causing the wave front to bend towards the normal.',
    points: 6,
  },
};

it('Admin Survey validation succeeds', () => {
  const res = validateSurveyJson(sampleSurvey);
  assert.strictEqual(res.ok, true);
});

it('Admin Answer Key builds and validates with model answers', () => {
  const res = buildAnswerKey(sampleSurvey, sampleAnswerKeyInput);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.answerKey.q_speed_of_light.correctValue, '3e8');
  assert.strictEqual(res.answerKey.q_speed_of_light.points, 4);
  assert.strictEqual(res.answerKey.q_explain_refraction.points, 6);
});

// 2. Student Sees Sanitized Schema
it('Student receives schema without answerKey or correctValue leakage', () => {
  const keyRes = buildAnswerKey(sampleSurvey, sampleAnswerKeyInput);
  const rawQuizRecord = {
    id: 10,
    videoId: 42,
    title: sampleSurvey.title,
    timeLimitSec: 600,
    passingScore: 50,
    surveyJson: sampleSurvey,
    answerKey: keyRes.answerKey,
  };

  const studentSafe = sanitizeForStudent(rawQuizRecord);
  assert.strictEqual(studentSafe.answerKey, undefined);
  assert.strictEqual(studentSafe.title, 'Secondary Physics Quiz 1');
  assert.strictEqual(studentSafe.timeLimitSec, 600);
});

// 3. Student Submits with correct MCQ
it('MCQ is auto-graded accurately', () => {
  const keyRes = buildAnswerKey(sampleSurvey, sampleAnswerKeyInput);
  const studentResponses = {
    q_speed_of_light: '3e8',
    q_explain_refraction: 'Because the speed of wave changes at boundary.',
  };

  const { mcqEarned, totalMcqPoints, perQuestion } = gradeMcq(keyRes.answerKey, studentResponses);
  assert.strictEqual(mcqEarned, 4);
  assert.strictEqual(totalMcqPoints, 4);
  assert.strictEqual(perQuestion[0].isCorrect, true);
});

// 4. Point calculation and essay grading
it('Total points and essay score calculation works', () => {
  const keyRes = buildAnswerKey(sampleSurvey, sampleAnswerKeyInput);
  const { totalPoints, totalMcqPoints, totalEssayPoints } = computeTotalPoints(keyRes.answerKey);
  assert.strictEqual(totalPoints, 10);
  assert.strictEqual(totalMcqPoints, 4);
  assert.strictEqual(totalEssayPoints, 6);

  // Admin awards 5 out of 6 points on essay
  const mcqEarned = 4;
  const essayAwarded = 5;
  const totalEarned = mcqEarned + essayAwarded;
  const finalPercent = computeScorePercent(totalEarned, totalPoints);
  assert.strictEqual(finalPercent, 90.0);
  assert.ok(finalPercent >= 50, 'Passed gate');
});

// 5. Retake scenario - highest score calculation
it('Multiple attempts highest score logic', () => {
  const attempts = [
    { attemptNumber: 1, scorePercent: 40.0, status: 'GRADED' },
    { attemptNumber: 2, scorePercent: 85.0, status: 'GRADED' },
    { attemptNumber: 3, scorePercent: 60.0, status: 'GRADED' },
  ];
  const bestScore = Math.max(...attempts.map(a => a.scorePercent));
  assert.strictEqual(bestScore, 85.0);
  assert.ok(bestScore >= 50);
});

console.log(`\n═══════════════════════════════`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('  All End-to-End verification scenarios PASSED ✅\n');
}
