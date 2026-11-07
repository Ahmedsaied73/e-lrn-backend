'use strict';

/**
 * Phase 7 Tests — Admin Chat Agent Rich Tools & Prompt
 *
 * Verifies that:
 * 1. upsert_quiz accepts question text and reference answers as either plain strings
 *    or arrays of blocks [{t, v}], converts them with serializeRich, and validates with validateRich.
 * 2. grade_essay accepts essayFeedback and referenceAnswers as plain strings or arrays of blocks [{t, v}],
 *    converts block arrays with serializeRich, and validates with validateRich.
 * 3. Malformed LaTeX, unbalanced chem braces, and forbidden commands are rejected with appropriate error codes.
 * 4. Agent prompt builder appends instructions for LaTeX math, mhchem chemistry, and block separation.
 * 5. Gemini JSON Schema stripping maintains valid schema without losing arguments.
 */

process.env.REDIS_ENABLED = 'false';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { getDefinition, toLangChainTools } = require('../src/services/agent/tools');
const { execute } = require('../src/services/agent/tools/_kit');
const { buildSystemPrompt } = require('../src/services/agent/graph');
const { parseRich, looksRich } = require('../src/lib/richContent');
const quizService = require('../src/services/quizService');
const { disconnectRedis } = require('../src/integrations/redis/redisClient');

function approved(prisma) {
  return { prisma, adminId: 1 };
}

after(async () => {
  await disconnectRedis();
});

describe('Phase 7: Agent Rich Tools — upsert_quiz', () => {
  it('upsert_quiz accepts plain string question title and reference answer', async () => {
    let capturedCreate = null;
    const stubPrisma = {
      bunnyVideo: {
        findUnique: async () => ({ id: 10, title: 'فيديو شرح الرياضيات', courseId: 1 }),
      },
      quiz: {
        findUnique: async () => null,
        upsert: async ({ create }) => {
          capturedCreate = create;
          return { id: 101, slug: 'quiz123abc45', title: create.title, passingScore: 50, maxAttempts: 3, timeLimitSec: null };
        },
      },
    };

    const result = await execute(
      getDefinition('upsert_quiz'),
      {
        videoSlug: 'vid123abc456',
        title: 'اختبار الرياضيات الأساسي',
        surveyJson: {
          pages: [
            {
              name: 'p1',
              elements: [
                { type: 'comment', name: 'q1', title: 'ما هو قانون الجاذبية العام؟' },
              ],
            },
          ],
        },
        answerKey: {
          q1: {
            type: 'comment',
            points: 10,
            modelAnswer: 'قوة الجذب تتناسب طردياً مع حاصل ضرب الكتلتين وعكسياً مع مربع المسافة.',
          },
        },
      },
      approved(stubPrisma)
    );

    assert.equal(result.data.ok, true);
    assert.ok(capturedCreate);
    const q1Title = capturedCreate.surveyJson.pages[0].elements[0].title;
    assert.equal(typeof q1Title, 'string');
    assert.equal(looksRich(q1Title), false, 'Plain text title remains plain');
    assert.equal(capturedCreate.answerKey.q1.modelAnswer.includes('قوة الجذب'), true);
  });

  it('upsert_quiz converts rich block arrays in surveyJson.title and answerKey.modelAnswer', async () => {
    let capturedCreate = null;
    const stubPrisma = {
      bunnyVideo: {
        findUnique: async () => ({ id: 10, title: 'فيديو التفاضل والتكامل', courseId: 1 }),
      },
      quiz: {
        findUnique: async () => null,
        upsert: async ({ create }) => {
          capturedCreate = create;
          return { id: 102, slug: 'quiz123abc46', title: create.title, passingScore: 50, maxAttempts: 3, timeLimitSec: null };
        },
      },
    };

    const richTitleBlocks = [
      { t: 'text', v: 'أوجد قيمة التكامل المحدود الآتي:' },
      { t: 'math', v: '\\int_{0}^{1} x^{2} \\, dx' },
    ];

    const richAnswerBlocks = [
      { t: 'text', v: 'الحل النموذجي خطوة بخطوة:' },
      { t: 'math', v: '\\left[ \\frac{x^3}{3} \\right]_0^1 = \\frac{1}{3}' },
    ];

    const result = await execute(
      getDefinition('upsert_quiz'),
      {
        videoSlug: 'vid123abc456',
        title: 'اختبار التفاضل المتقدم',
        surveyJson: {
          pages: [
            {
              name: 'p1',
              elements: [
                { type: 'comment', name: 'q1', title: richTitleBlocks, answerFormat: 'RICH' },
              ],
            },
          ],
        },
        answerKey: {
          q1: {
            type: 'comment',
            points: 10,
            modelAnswer: richAnswerBlocks,
          },
        },
      },
      approved(stubPrisma)
    );

    assert.equal(result.data.ok, true);
    assert.ok(capturedCreate);

    const q1Title = capturedCreate.surveyJson.pages[0].elements[0].title;
    assert.ok(looksRich(q1Title), 'Title block array converted to envelope string');
    const parsedTitle = parseRich(q1Title);
    assert.equal(parsedTitle.blocks.length, 2);
    assert.equal(parsedTitle.blocks[0].t, 'text');
    assert.equal(parsedTitle.blocks[1].t, 'math');
    assert.equal(parsedTitle.blocks[1].v, '\\int_{0}^{1} x^{2} \\, dx');

    const modelAns = capturedCreate.answerKey.q1.modelAnswer;
    assert.ok(looksRich(modelAns), 'modelAnswer block array converted to envelope string');
    const parsedAns = parseRich(modelAns);
    assert.equal(parsedAns.blocks.length, 2);
    assert.equal(parsedAns.blocks[1].v, '\\left[ \\frac{x^3}{3} \\right]_0^1 = \\frac{1}{3}');
  });

  it('upsert_quiz converts chemistry blocks with mhchem syntax in question and referenceAnswer', async () => {
    let capturedCreate = null;
    const stubPrisma = {
      bunnyVideo: {
        findUnique: async () => ({ id: 10, title: 'فيديو الكيمياء العامة', courseId: 1 }),
      },
      quiz: {
        findUnique: async () => null,
        upsert: async ({ create }) => {
          capturedCreate = create;
          return { id: 103, slug: 'quiz123abc47', title: create.title, passingScore: 50, maxAttempts: 3, timeLimitSec: null };
        },
      },
    };

    const chemTitleBlocks = [
      { t: 'text', v: 'اكتب المعادلة الموزونة لتفاعل الاحتراق التالي:' },
      { t: 'chem', v: 'CH4 + 2O2 -> CO2 + 2H2O' },
    ];

    const chemAnswerBlocks = [
      { t: 'chem', v: 'CH4 + 2O2 -> CO2 + 2H2O' },
    ];

    const result = await execute(
      getDefinition('upsert_quiz'),
      {
        videoSlug: 'vid123abc456',
        title: 'اختبار الكيمياء الحركية',
        surveyJson: {
          pages: [
            {
              name: 'p1',
              elements: [
                { type: 'comment', name: 'q1', title: chemTitleBlocks },
              ],
            },
          ],
        },
        answerKey: {
          q1: {
            type: 'comment',
            points: 10,
            referenceAnswer: chemAnswerBlocks,
          },
        },
      },
      approved(stubPrisma)
    );

    assert.equal(result.data.ok, true);
    assert.ok(capturedCreate);
    const parsedAns = parseRich(capturedCreate.answerKey.q1.modelAnswer);
    assert.equal(parsedAns.blocks[0].t, 'chem');
    assert.equal(parsedAns.blocks[0].v, 'CH4 + 2O2 -> CO2 + 2H2O');
  });

  it('upsert_quiz rejects invalid LaTeX math syntax in blocks', async () => {
    const stubPrisma = {
      bunnyVideo: { findUnique: async () => ({ id: 10, title: 'فيديو', courseId: 1 }) },
      quiz: { findUnique: async () => null, upsert: async () => ({ id: 1 }) },
    };

    const result = await execute(
      getDefinition('upsert_quiz'),
      {
        videoSlug: 'vid123abc456',
        title: 'اختبار',
        surveyJson: {
          pages: [
            {
              name: 'p1',
              elements: [
                { type: 'comment', name: 'q1', title: [{ t: 'math', v: '\\frac{1}{' }] }, // unclosed brace
              ],
            },
          ],
        },
        answerKey: { q1: { type: 'comment', points: 10, modelAnswer: 'إجابة' } },
      },
      approved(stubPrisma)
    );

    assert.equal(result.data.ok, false);
    assert.equal(result.data.reason, 'INVALID_SURVEY_JSON');
    assert.equal(result.data.code, 'RICH_BAD_MATH');
  });

  it('upsert_quiz rejects forbidden LaTeX commands in blocks', async () => {
    const stubPrisma = {
      bunnyVideo: { findUnique: async () => ({ id: 10, title: 'فيديو', courseId: 1 }) },
      quiz: { findUnique: async () => null, upsert: async () => ({ id: 1 }) },
    };

    const result = await execute(
      getDefinition('upsert_quiz'),
      {
        videoSlug: 'vid123abc456',
        title: 'اختبار أمني',
        surveyJson: {
          pages: [
            {
              name: 'p1',
              elements: [
                { type: 'comment', name: 'q1', title: 'سؤال عادي' },
              ],
            },
          ],
        },
        answerKey: {
          q1: {
            type: 'comment',
            points: 10,
            modelAnswer: [{ t: 'math', v: '\\input{/etc/passwd}' }],
          },
        },
      },
      approved(stubPrisma)
    );

    assert.equal(result.data.ok, false);
    assert.equal(result.data.reason, 'INVALID_ANSWER_KEY');
    assert.equal(result.data.code, 'RICH_FORBIDDEN_COMMAND');
  });

  it('upsert_quiz accepts friendly questions array with rich blocks', async () => {
    let capturedCreate = null;
    const stubPrisma = {
      bunnyVideo: { findUnique: async () => ({ id: 10, title: 'فيديو', courseId: 1 }) },
      quiz: {
        findUnique: async () => null,
        upsert: async ({ create }) => {
          capturedCreate = create;
          return { id: 104, slug: 'quiz123abc48', title: create.title, passingScore: 50, maxAttempts: 3, timeLimitSec: null };
        },
      },
    };

    const result = await execute(
      getDefinition('upsert_quiz'),
      {
        videoSlug: 'vid123abc456',
        title: 'اختبار عبر مصفوفة الأسئلة',
        questions: [
          {
            name: 'q1',
            type: 'comment',
            title: [{ t: 'text', v: 'احسب المشتقة:' }, { t: 'math', v: 'f(x) = x^3' }],
            points: 10,
            referenceAnswer: [{ t: 'math', v: "f'(x) = 3x^2" }],
            answerFormat: 'RICH',
          },
        ],
      },
      approved(stubPrisma)
    );

    assert.equal(result.data.ok, true);
    assert.ok(capturedCreate);
    const title = capturedCreate.surveyJson.pages[0].elements[0].title;
    assert.ok(looksRich(title));
    const modelAns = capturedCreate.answerKey.q1.modelAnswer;
    assert.ok(looksRich(modelAns));
  });
});

describe('Phase 7: Agent Rich Tools — grade_essay', () => {
  const origGradeEssayAttempt = quizService.gradeEssayAttempt;

  it('grade_essay accepts plain string feedback', async () => {
    let capturedArgs = null;
    quizService.gradeEssayAttempt = async (adminId, attemptId, essayScores, essayFeedback) => {
      capturedArgs = { adminId, attemptId, essayScores, essayFeedback };
      return {
        id: attemptId,
        status: 'GRADED',
        scorePercent: 100,
        earnedPoints: 10,
        totalPoints: 10,
        essayGradedAt: new Date(),
      };
    };

    try {
      const result = await execute(
        getDefinition('grade_essay'),
        {
          attemptId: 201,
          essayScores: { q1: 10 },
          essayFeedback: { q1: 'إجابة ممتازة وخطوات صحيحة.' },
        },
        approved({})
      );

      assert.equal(result.data.ok, true);
      assert.equal(capturedArgs.essayFeedback.q1, 'إجابة ممتازة وخطوات صحيحة.');
    } finally {
      quizService.gradeEssayAttempt = origGradeEssayAttempt;
    }
  });

  it('grade_essay converts rich block array feedback into serialized envelope', async () => {
    let capturedArgs = null;
    quizService.gradeEssayAttempt = async (adminId, attemptId, essayScores, essayFeedback) => {
      capturedArgs = { adminId, attemptId, essayScores, essayFeedback };
      return {
        id: attemptId,
        status: 'GRADED',
        scorePercent: 90,
        earnedPoints: 9,
        totalPoints: 10,
        essayGradedAt: new Date(),
      };
    };

    const richFeedbackBlocks = [
      { t: 'text', v: 'أحسنت! لكن انتبه لثابت التكامل في الخطوة الأخيرة:' },
      { t: 'math', v: '\\int f(x)\\,dx = F(x) + C' },
    ];

    try {
      const result = await execute(
        getDefinition('grade_essay'),
        {
          attemptId: 202,
          essayScores: { q1: 9 },
          essayFeedback: { q1: richFeedbackBlocks },
        },
        approved({})
      );

      assert.equal(result.data.ok, true);
      assert.ok(capturedArgs);
      const fbText = capturedArgs.essayFeedback.q1;
      assert.ok(looksRich(fbText), 'Feedback block array converted to envelope string');
      const parsed = parseRich(fbText);
      assert.equal(parsed.blocks.length, 2);
      assert.equal(parsed.blocks[1].t, 'math');
      assert.equal(parsed.blocks[1].v, '\\int f(x)\\,dx = F(x) + C');
    } finally {
      quizService.gradeEssayAttempt = origGradeEssayAttempt;
    }
  });

  it('grade_essay rejects invalid LaTeX math in feedback', async () => {
    const result = await execute(
      getDefinition('grade_essay'),
      {
        attemptId: 203,
        essayScores: { q1: 5 },
        essayFeedback: {
          q1: [{ t: 'math', v: '\\sqrt{' }], // invalid unclosed brace
        },
      },
      approved({})
    );

    assert.equal(result.data.ok, false);
    assert.equal(result.data.reason, 'INVALID_ESSAY_FEEDBACK');
    assert.equal(result.data.code, 'RICH_BAD_MATH');
  });

  it('grade_essay accepts referenceAnswers and questionText with rich blocks', async () => {
    let capturedArgs = null;
    quizService.gradeEssayAttempt = async (adminId, attemptId, essayScores, essayFeedback) => {
      capturedArgs = { adminId, attemptId, essayScores, essayFeedback };
      return {
        id: attemptId,
        status: 'GRADED',
        scorePercent: 100,
        earnedPoints: 10,
        totalPoints: 10,
        essayGradedAt: new Date(),
      };
    };

    try {
      const result = await execute(
        getDefinition('grade_essay'),
        {
          attemptId: 204,
          essayScores: { q1: 10 },
          essayFeedback: { q1: 'ممتاز' },
          referenceAnswers: {
            q1: [{ t: 'math', v: 'E = mc^2' }],
          },
          questionText: {
            q1: [{ t: 'text', v: 'ما هي معادلة أينشتاين؟' }],
          },
        },
        approved({})
      );

      assert.equal(result.data.ok, true);
      assert.ok(result.data.referenceAnswers);
      assert.ok(looksRich(result.data.referenceAnswers.q1));
      assert.ok(result.data.questionText);
      assert.equal(result.data.questionText.q1, 'ما هي معادلة أينشتاين؟');
    } finally {
      quizService.gradeEssayAttempt = origGradeEssayAttempt;
    }
  });
});

describe('Phase 7: Agent System Prompt Instructions', () => {
  it('buildSystemPrompt includes rich math and chemistry instructions', () => {
    const prompt = buildSystemPrompt({ now: new Date(2026, 10, 7) });

    assert.ok(
      prompt.includes('استخدم مقاطع math مع كود LaTeX للمعادلات الرياضية'),
      'Prompt instructs model to use math blocks with LaTeX'
    );
    assert.ok(
      prompt.includes('استخدم مقاطع chem مع صيغة mhchem للمعادلات الكيميائية'),
      'Prompt instructs model to use chem blocks with mhchem'
    );
    assert.ok(
      prompt.includes('لا تخلط أبداً بين الشرح اللغوي والمعادلات داخل مقطع math أو chem'),
      'Prompt instructs model never to mix prose into math blocks'
    );
  });
});

describe('Phase 7: Model Transport Safety (Gemini schema stripping)', () => {
  it('toLangChainTools successfully converts upsert_quiz and grade_essay schemas', () => {
    const tools = toLangChainTools([
      getDefinition('upsert_quiz'),
      getDefinition('grade_essay'),
    ]);

    assert.equal(tools.length, 2);
    assert.equal(tools[0].name, 'upsert_quiz');
    assert.equal(tools[1].name, 'grade_essay');

    // Confirm that the stripped schema retains expected properties
    const upsertProps = tools[0].schema.properties;
    assert.ok(upsertProps.videoSlug, 'videoSlug argument retained');
    assert.ok(upsertProps.title, 'title argument retained');

    const gradeProps = tools[1].schema.properties;
    assert.ok(gradeProps.attemptId, 'attemptId argument retained');
    assert.ok(gradeProps.essayScores, 'essayScores argument retained');
  });
});
