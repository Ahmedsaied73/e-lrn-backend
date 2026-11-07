'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildGradingPrompt,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  RICH_GRADING_RULES,
  MAX_STUDENT_CHARS,
  MAX_MODEL_CHARS,
} = require('../src/services/aiGrader/prompts');

const { toGraderText } = require('../src/lib/richContent/grader');

test('aiGrader prompts: plain text answers without $$ have byte-for-byte identical SYSTEM_PROMPT', () => {
  const plainStudent = 'باريس هي عاصمة فرنسا وتقع على نهر السين.';
  const plainModel = 'باريس هي عاصمة فرنسا وتقع على نهر السين.';
  const rubric = 'ذكر باريس = 6 درجات، ذكر نهر السين = 4 درجات.';

  const prompt = buildGradingPrompt({
    questionTitle: 'ما عاصمة فرنسا؟',
    modelAnswer: plainModel,
    rubric,
    studentAnswer: plainStudent,
    maxPoints: 10,
  });

  // Strict identity assertion: byte-for-byte identical to baseline
  assert.equal(prompt.system, SYSTEM_PROMPT, 'System prompt must be byte-for-byte identical to baseline for plain text');
  assert.equal(prompt.system.includes('RICH_GRADING_RULES'), false);
  assert.equal(prompt.system.includes('$$'), false);
  assert.equal(prompt.version, PROMPT_VERSION);
  assert.ok(prompt.user.includes(plainStudent));
  assert.ok(prompt.user.includes(plainModel));
});

test('aiGrader prompts: rich envelope with math block appends RICH_GRADING_RULES verbatim', () => {
  const richStudent = JSON.stringify({
    v: 1,
    blocks: [
      { t: 'text', v: 'حل المعادلة هو:' },
      { t: 'math', v: 'x = \\frac{1}{2}' },
    ],
  });
  const plainModel = 'x = 0.5';

  const prompt = buildGradingPrompt({
    questionTitle: 'أوجد قيمة x',
    modelAnswer: plainModel,
    rubric: 'الحل الصحيح = 10 درجات',
    studentAnswer: richStudent,
    maxPoints: 10,
  });

  const expectedSystem = `${SYSTEM_PROMPT}\n\n${RICH_GRADING_RULES}`;
  assert.equal(prompt.system, expectedSystem, 'System prompt must have RICH_GRADING_RULES appended verbatim');
  assert.ok(prompt.system.includes('RICH_GRADING_RULES'));
  assert.ok(prompt.user.includes('$$ x = \\frac{1}{2} $$'));
});

test('aiGrader prompts: rich envelope with chem block appends RICH_GRADING_RULES verbatim', () => {
  const plainStudent = 'تفاعل الهيدروجين مع الأكسجين';
  const richModel = JSON.stringify({
    v: 1,
    blocks: [
      { t: 'text', v: 'معادلة التفاعل الموزونة:' },
      { t: 'chem', v: '2H2 + O2 -> 2H2O' },
    ],
  });

  const prompt = buildGradingPrompt({
    questionTitle: 'اكتب تفاعل تكوين الماء',
    modelAnswer: richModel,
    rubric: 'معادلة موزونة',
    studentAnswer: plainStudent,
    maxPoints: 10,
  });

  const expectedSystem = `${SYSTEM_PROMPT}\n\n${RICH_GRADING_RULES}`;
  assert.equal(prompt.system, expectedSystem, 'Model answer containing $$ should trigger RICH_GRADING_RULES');
  assert.ok(prompt.user.includes('$$ \\ce{2H2 + O2 -> 2H2O} $$'));
});

test('aiGrader prompts: plain string containing $$ directly triggers RICH_GRADING_RULES', () => {
  const prompt = buildGradingPrompt({
    questionTitle: 'معادلة',
    modelAnswer: 'x = 2',
    rubric: '',
    studentAnswer: 'القيمة هي $$ x = 2 $$',
    maxPoints: 5,
  });

  const expectedSystem = `${SYSTEM_PROMPT}\n\n${RICH_GRADING_RULES}`;
  assert.equal(prompt.system, expectedSystem);
});

test('aiGrader prompts: rich envelope with only text blocks stays byte-for-byte identical to baseline', () => {
  const richOnlyText = JSON.stringify({
    v: 1,
    blocks: [
      { t: 'text', v: 'الفقرة الأولى' },
      { t: 'text', v: 'الفقرة الثانية' },
    ],
  });

  const prompt = buildGradingPrompt({
    questionTitle: 'سؤال نصي',
    modelAnswer: 'نموذج الإجابة',
    rubric: '',
    studentAnswer: richOnlyText,
    maxPoints: 5,
  });

  assert.equal(prompt.system, SYSTEM_PROMPT, 'Envelope with only text blocks should not trigger RICH_GRADING_RULES');
});

test('aiGrader prompts: RICH_GRADING_RULES contains all mandated guidelines', () => {
  assert.ok(RICH_GRADING_RULES.includes('1/2, 0.5 and \\frac{1}{2} are the same'));
  assert.ok(RICH_GRADING_RULES.includes('س and ص'));
  assert.ok(RICH_GRADING_RULES.includes('\\cdot versus \\times, \\dfrac versus \\frac'));
  assert.ok(RICH_GRADING_RULES.includes('constant of integration'));
  assert.ok(RICH_GRADING_RULES.includes('unreadable or malformed'));
  assert.ok(RICH_GRADING_RULES.includes('Chemical equations'));
});

test('aiGrader prompts: toGraderText and input cap checks', () => {
  const normalAnswer = 'x = 1';
  assert.equal(toGraderText(normalAnswer), normalAnswer);

  const richAnswer = JSON.stringify({
    v: 1,
    blocks: [
      { t: 'text', v: 'خطوة 1:' },
      { t: 'math', v: 'y = 2x + 1' },
    ],
  });
  const converted = toGraderText(richAnswer);
  assert.equal(converted, 'خطوة 1:\n$$ y = 2x + 1 $$');
  assert.ok(converted.length < MAX_STUDENT_CHARS);

  // Oversized text
  const longText = 'x'.repeat(MAX_STUDENT_CHARS + 50);
  const convertedLong = toGraderText(longText);
  assert.ok(convertedLong.length > MAX_STUDENT_CHARS);
});
