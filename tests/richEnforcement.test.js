'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const quizService = require('../src/services/quizService');
const quizController = require('../src/controllers/quizController');
const { STATUS } = require('../src/config/quizConfig');

test('Admin authoring: validateSurveyJson enforces question title and answerFormat', () => {
  // Valid survey with plain essay
  const validPlainSurvey = {
    pages: [
      {
        elements: [
          { type: 'comment', name: 'q1', title: 'اشرح مبدأ ارخميدس بالتفصيل' },
        ],
      },
    ],
  };
  const res1 = quizService.validateSurveyJson(validPlainSurvey);
  assert.equal(res1.ok, true);

  // Valid survey with rich math title
  const validRichSurvey = {
    pages: [
      {
        elements: [
          {
            type: 'comment',
            name: 'q1',
            title: '{"v":1,"blocks":[{"t":"text","v":"حل المعادلة التالية:"},{"t":"math","v":"x^2+y^2=z^2"}]}',
            answerFormat: 'RICH',
          },
        ],
      },
    ],
  };
  const res2 = quizService.validateSurveyJson(validRichSurvey);
  assert.equal(res2.ok, true);

  // Invalid survey with forbidden command in title
  const invalidTitleSurvey = {
    pages: [
      {
        elements: [
          {
            type: 'comment',
            name: 'q1',
            title: '{"v":1,"blocks":[{"t":"math","v":"\\\\input{/etc/passwd}"}]}',
          },
        ],
      },
    ],
  };
  const res3 = quizService.validateSurveyJson(invalidTitleSurvey);
  assert.equal(res3.ok, false);
  assert.ok(res3.errors.some((e) => e.includes('RICH_FORBIDDEN_COMMAND')));

  // Invalid answerFormat value
  const invalidFormatSurvey = {
    pages: [
      {
        elements: [
          {
            type: 'comment',
            name: 'q1',
            title: 'سؤال تجريبي',
            answerFormat: 'MARKDOWN', // invalid format
          },
        ],
      },
    ],
  };
  const res4 = quizService.validateSurveyJson(invalidFormatSurvey);
  assert.equal(res4.ok, false);
  assert.ok(res4.errors.some((e) => e.includes('answerFormat must be "PLAIN", "RICH", or null')));
});

test('Admin authoring: buildAnswerKey validates modelAnswer and answerFormat', () => {
  const surveyJson = {
    pages: [
      {
        elements: [
          { type: 'comment', name: 'q1', title: 'سؤال مقالي' },
        ],
      },
    ],
  };

  // Valid plain modelAnswer
  const validKeyInput = {
    q1: {
      type: 'comment',
      points: 10,
      modelAnswer: 'الإجابة النموذجية باللغة العربية.',
      answerFormat: 'PLAIN',
    },
  };
  const r1 = quizService.buildAnswerKey(surveyJson, validKeyInput);
  assert.equal(r1.ok, true);
  assert.equal(r1.answerKey.q1.answerFormat, 'PLAIN');

  // Valid rich modelAnswer
  const validRichKeyInput = {
    q1: {
      type: 'comment',
      points: 10,
      modelAnswer: '{"v":1,"blocks":[{"t":"math","v":"\\\\frac{1}{2}"}]}',
      answerFormat: 'RICH',
    },
  };
  const r2 = quizService.buildAnswerKey(surveyJson, validRichKeyInput);
  assert.equal(r2.ok, true);
  assert.equal(r2.answerKey.q1.answerFormat, 'RICH');

  // Invalid modelAnswer: bad math
  const badMathKeyInput = {
    q1: {
      type: 'comment',
      points: 10,
      modelAnswer: '{"v":1,"blocks":[{"t":"math","v":"\\\\frac{1}{"}]}',
    },
  };
  const r3 = quizService.buildAnswerKey(surveyJson, badMathKeyInput);
  assert.equal(r3.ok, false);
  assert.ok(r3.errors.some((e) => e.includes('RICH_BAD_MATH')));

  // Invalid modelAnswer: forbidden command
  const forbiddenKeyInput = {
    q1: {
      type: 'comment',
      points: 10,
      modelAnswer: '{"v":1,"blocks":[{"t":"math","v":"\\\\href{http://evil.com}{click}"}]}',
    },
  };
  const r4 = quizService.buildAnswerKey(surveyJson, forbiddenKeyInput);
  assert.equal(r4.ok, false);
  assert.ok(r4.errors.some((e) => e.includes('RICH_FORBIDDEN_COMMAND')));

  // Invalid answerFormat in key
  const badFormatKeyInput = {
    q1: {
      type: 'comment',
      points: 10,
      modelAnswer: 'إجابة عادية',
      answerFormat: 'LATEX',
    },
  };
  const r5 = quizService.buildAnswerKey(surveyJson, badFormatKeyInput);
  assert.equal(r5.ok, false);
  assert.ok(r5.errors.some((e) => e.includes('answerFormat must be "PLAIN", "RICH", or null')));
});

test('Student quiz start: sanitizeForStudent resolves effectiveFormat', () => {
  const quiz = {
    slug: 'quiz-slug-1',
    title: 'اختبار الرياضيات والكيمياء',
    timeLimitSec: 1800,
    passingScore: 60,
    maxAttempts: 3,
    surveyJson: {
      pages: [
        {
          elements: [
            { type: 'radiogroup', name: 'q1', title: 'سؤال اختياري' },
            { type: 'comment', name: 'q2', title: 'سؤال مقالي افتراضي', answerFormat: null },
            { type: 'comment', name: 'q3', title: 'سؤال مقالي نصي صريح', answerFormat: 'PLAIN' },
          ],
        },
      ],
    },
    answerKey: {
      q1: { type: 'radiogroup', points: 5, correctValue: 'A' },
      q2: { type: 'comment', points: 10, modelAnswer: 'حل 1', answerFormat: null },
      q3: { type: 'comment', points: 10, modelAnswer: 'حل 2', answerFormat: 'PLAIN' },
    },
  };

  const sanitized = quizService.sanitizeForStudent(quiz);

  // answerKey is excluded
  assert.equal(sanitized.answerKey, undefined);

  // Check resolved formats
  const elements = sanitized.surveyJson.pages[0].elements;
  assert.equal(elements[0].type, 'radiogroup');

  // q2 had null answerFormat; on default deployment (or subjectProfile fallback) resolves to effectiveFormat
  assert.ok(elements[1].effectiveFormat === 'PLAIN' || elements[1].effectiveFormat === 'RICH');
  assert.equal(elements[1].answerFormat, elements[1].effectiveFormat);

  // q3 had explicit PLAIN answerFormat; stays PLAIN
  assert.equal(elements[2].effectiveFormat, 'PLAIN');
  assert.equal(elements[2].answerFormat, 'PLAIN');
});

test('AC-6 Invariant: getQuizResult NEVER returns modelAnswer to students', async () => {
  // Mock attempt row
  const mockAttempt = {
    id: 101,
    userId: 42,
    status: STATUS.GRADED,
    scorePercent: 100, // passed!
    earnedPoints: 20,
    totalPoints: 20,
    responses: {
      q1: 'B',
      q2: 'إجابة الطالب النصية',
    },
    essayFeedback: {
      q2: { awarded: 10, feedback: 'ممتاز أحسنت', gradedBy: 'teacher' },
    },
    quiz: {
      id: 1,
      title: 'اختبار الوحدة الأولى',
      passingScore: 50,
      answerKey: {
        q1: { type: 'radiogroup', points: 10, correctValue: 'B' },
        q2: {
          type: 'comment',
          points: 10,
          modelAnswer: 'سر الإجابة النموذجية التي لا يجب أن يراها الطالب إطلاقا',
        },
      },
    },
  };

  // Helper to simulate request through controller
  async function runGetQuizResult(role) {
    let statusCode = 0;
    let jsonResult = null;

    const req = {
      params: { id: '101' },
      user: { id: 42, role },
    };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResult = data;
        return this;
      },
    };

    // Temporarily stub prisma.quizAttempt.findUnique
    const db = require('../src/config/db');
    const origFindUnique = db.quizAttempt.findUnique;
    db.quizAttempt.findUnique = async () => mockAttempt;

    try {
      await quizController.getQuizResult(req, res);
    } finally {
      db.quizAttempt.findUnique = origFindUnique;
    }

    return { statusCode, jsonResult };
  }

  // 1. Student Request (role === 'STUDENT')
  const studentRes = await runGetQuizResult('STUDENT');
  assert.equal(studentRes.statusCode, 200);
  assert.equal(studentRes.jsonResult.success, true);

  const studentBreakdown = studentRes.jsonResult.data.questions;
  const studentEssay = studentBreakdown.find((q) => q.name === 'q2');
  assert.ok(studentEssay, 'Essay question must be in breakdown');
  assert.equal('modelAnswer' in studentEssay, false, 'modelAnswer MUST NOT exist in student response');
  assert.equal(studentEssay.modelAnswer, undefined, 'modelAnswer must be undefined for student');

  // Verify full stringified payload does not contain the secret model answer text
  const serialized = JSON.stringify(studentRes.jsonResult);
  assert.equal(
    serialized.includes('سر الإجابة النموذجية'),
    false,
    'Model answer text must never leak into student payload'
  );

  // 2. Admin Request (role === 'ADMIN')
  const adminRes = await runGetQuizResult('ADMIN');
  assert.equal(adminRes.statusCode, 200);
  const adminBreakdown = adminRes.jsonResult.data.questions;
  const adminEssay = adminBreakdown.find((q) => q.name === 'q2');
  assert.ok(adminEssay);
  assert.equal(adminEssay.modelAnswer, 'سر الإجابة النموذجية التي لا يجب أن يراها الطالب إطلاقا');
});

test('Student submit & save: PLAIN vs RICH question enforcement', async () => {
  const mockQuiz = {
    id: 1,
    title: 'اختبار تجريبي',
    surveyJson: {
      pages: [
        {
          elements: [
            { type: 'comment', name: 'qPlain', answerFormat: 'PLAIN' },
            { type: 'comment', name: 'qRich', answerFormat: 'RICH' },
          ],
        },
      ],
    },
    answerKey: {
      qPlain: { type: 'comment', points: 10, modelAnswer: 'حل عادي', answerFormat: 'PLAIN' },
      qRich: { type: 'comment', points: 10, modelAnswer: '{"v":1,"blocks":[{"t":"math","v":"x^2"}]}', answerFormat: 'RICH' },
    },
  };

  const mockAttempt = {
    id: 200,
    userId: 99,
    status: STATUS.IN_PROGRESS,
    quizId: 1,
    quiz: mockQuiz,
    quizSnapshot: null,
    deadlineAt: null,
  };

  const db = require('../src/config/db');
  const cache = require('../src/integrations/redis/cache');
  const { disconnectRedis } = require('../src/integrations/redis/redisClient');

  const origFindUnique = db.quizAttempt.findUnique;
  const origUpdateMany = db.quizAttempt.updateMany;
  const origUpdate = db.quizAttempt.update;
  const origDelPrefix = cache.delPrefix;
  const origDel = cache.del;

  db.quizAttempt.findUnique = async () => mockAttempt;
  db.quizAttempt.updateMany = async () => ({ count: 1 });
  db.quizAttempt.update = async () => ({ id: 200 });
  cache.delPrefix = async () => {};
  cache.del = async () => {};

  try {
    // 1. PLAIN question + plain text answer: SUCCESS
    const res1 = await quizService.submitAttempt(99, 200, {
      qPlain: 'هذه إجابة نصية عادية باللغة العربية مع تفاصيل كاملة.',
      qRich: 'إجابة نصية لسؤال الرياضيات مقبولة أيضاً',
    });
    assert.equal(res1.attempt.id, 200);

    // 2. PLAIN question + rich envelope answer: REJECTED with RICH_NOT_ALLOWED
    await assert.rejects(
      async () => {
        await quizService.submitAttempt(99, 200, {
          qPlain: '{"v":1,"blocks":[{"t":"math","v":"\\\\frac{1}{2}"}]}',
        });
      },
      (err) => {
        assert.equal(err.code, 'RICH_NOT_ALLOWED');
        assert.equal(err.statusCode, 400);
        return true;
      }
    );

    // 3. RICH question + valid rich envelope: SUCCESS
    const res3 = await quizService.submitAttempt(99, 200, {
      qPlain: 'إجابة نصية',
      qRich: '{"v":1,"blocks":[{"t":"text","v":"خطوات الحل:"},{"t":"math","v":"\\\\sqrt{x^2+y^2}"}]}',
    });
    assert.equal(res3.attempt.id, 200);

    // 4. RICH question + invalid KaTeX math: REJECTED with RICH_BAD_MATH
    await assert.rejects(
      async () => {
        await quizService.submitAttempt(99, 200, {
          qRich: '{"v":1,"blocks":[{"t":"math","v":"\\\\frac{1}{"}]}',
        });
      },
      (err) => {
        assert.equal(err.code, 'RICH_BAD_MATH');
        assert.equal(err.statusCode, 400);
        return true;
      }
    );

    // 5. RICH question + forbidden LaTeX command: REJECTED with RICH_FORBIDDEN_COMMAND
    await assert.rejects(
      async () => {
        await quizService.submitAttempt(99, 200, {
          qRich: '{"v":1,"blocks":[{"t":"math","v":"\\\\href{http://evil.com}{hack}"}]}',
        });
      },
      (err) => {
        assert.equal(err.code, 'RICH_FORBIDDEN_COMMAND');
        assert.equal(err.statusCode, 400);
        return true;
      }
    );

    // 6. saveAttempt draft save enforces the same validation rules
    await assert.rejects(
      async () => {
        await quizService.saveAttempt(99, 200, {
          qPlain: '{"v":1,"blocks":[{"t":"math","v":"x^2"}]}',
        });
      },
      (err) => {
        assert.equal(err.code, 'RICH_NOT_ALLOWED');
        assert.equal(err.statusCode, 400);
        return true;
      }
    );

    // 7. Legacy Arabic plain text question and answer: byte-for-byte unchanged
    const legacyText = 'النص العربي القديم كما هو تماماً ١٢٣٤٥';
    const legacyRes = await quizService.saveAttempt(99, 200, {
      qPlain: legacyText,
    });
    assert.equal(legacyRes.id, 200);
  } finally {
    db.quizAttempt.findUnique = origFindUnique;
    db.quizAttempt.updateMany = origUpdateMany;
    db.quizAttempt.update = origUpdate;
    cache.delPrefix = origDelPrefix;
    cache.del = origDel;
    await disconnectRedis();
  }
});

