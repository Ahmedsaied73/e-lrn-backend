'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { gradeEssay } = require('../src/services/aiGrader/index');
const { createMockProvider } = require('../src/services/aiGrader/provider');

describe('ai grader structured rubric path', () => {
  it('uses the structured schema when a rubric item has no description', async () => {
    const rubric = [{ id: 'c1', points: 10 }];
    const provider = createMockProvider([{
      criteria: [{ id: 'c1', awarded: 8, evidence: 'Photosynthesis' }],
      maxScore: 10,
      confidence: 0.9,
      feedback: 'Good answer.',
    }]);

    const verdict = await gradeEssay({
      questionTitle: 'Explain photosynthesis',
      studentAnswer: 'Photosynthesis happens in leaves.',
      modelAnswer: 'Plants convert light to chemical energy.',
      rubric,
      maxPoints: 10,
    }, provider);

    assert.equal(verdict.score, 8);
    assert.equal(verdict.criteriaBreakdown[0].id, 'c1');
  });

  it('checks evidence against the converted rich answer the model saw', async () => {
    const envelope = JSON.stringify({
      v: 1,
      blocks: [{ t: 'chem', v: '2H2 + O2 -> 2H2O' }],
    });
    const evidence = '$$ \\ce{2H2 + O2 -> 2H2O} $$';
    const provider = createMockProvider([{
      criteria: [{ id: 'c1', awarded: 5, evidence }],
      maxScore: 5,
      confidence: 0.95,
      feedback: 'Balanced equation.',
    }]);

    const verdict = await gradeEssay({
      questionTitle: 'Balance the reaction',
      studentAnswer: envelope,
      modelAnswer: '2H2 + O2 -> 2H2O',
      rubric: [{ id: 'c1', description: 'Balanced equation', points: 5 }],
      maxPoints: 5,
    }, provider);

    assert.equal(verdict.score, 5);
  });
});
