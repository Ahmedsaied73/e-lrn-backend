'use strict';

/**
 * Phase 3 — the grounding guard (pure, offline).
 *
 * The templates cannot invent numbers; a model can. This suite pins exactly which
 * figures are allowed (payload values in their legitimate spellings, dates, and
 * the ratio→percent transform our own renderers use) and which are not (a
 * fabricated statistic), plus the deliberate blind spot for small integers.
 */

process.env.REDIS_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AnswerGroundingError,
  canonicalNumber,
  collectAllowed,
  extractFigures,
  checkGrounded,
  assertGrounded,
} = require('../src/services/agent/answerGuard');

const PAYLOAD = {
  windowDays: 30,
  summary: { students: 10036, passRate: 83.3, avgProgress: 0.9 },
  rows: [{ title: 'Quiz 1', score: 55.4, createdAt: '2026-09-24T11:02:33.568Z' }],
  returned: 3,
  truncated: true,
};

test('numbers are canonicalized regardless of separators', () => {
  assert.equal(canonicalNumber('1,234.50'), '1234.5');
  assert.equal(canonicalNumber('1234'), '1234');
  assert.equal(canonicalNumber('١٢٣٤'), '1234');
  assert.equal(canonicalNumber('١٬٢٣٤'), '1234');
  assert.equal(canonicalNumber('nope'), null);
  assert.equal(canonicalNumber(null), null);
});

test('everything reachable in the payload is allowed, in any legitimate spelling', () => {
  const allowed = collectAllowed(PAYLOAD);
  for (const value of ['10036', '83.3', '55.4', '30', '3', '0.9', '2026', '90']) {
    assert.ok(allowed.has(value), `expected "${value}" to be allowed`);
  }
});

test('figures a tool actually returned are accepted when the model rephrases them', () => {
  const answer = 'سجّل المنصة 10,036 طالباً، ونسبة النجاح 83.3%، ومتوسط الدرجات 55.4%.';
  const result = checkGrounded(answer, PAYLOAD);
  assert.deepEqual(result.ungrounded, []);
  // 10,036 / 83.3 / 55.4 are the significant figures here; "30" and "3" are not
  // in the text at all, and single/double-digit numbers are not claims.
  assert.equal(result.checked, 3);
});

test('a fabricated statistic is rejected, and named in the error', () => {
  const answer = 'أعلى دقة تصحيح بلغت 94.2% وهذا ممتاز.';
  const result = checkGrounded(answer, PAYLOAD);
  assert.equal(result.ok, false);
  assert.deepEqual(result.ungrounded, ['94.2']);

  assert.throws(() => assertGrounded(answer, PAYLOAD), (err) => {
    assert.ok(err instanceof AnswerGroundingError);
    assert.equal(err.code, 'UNGROUNDED_FIGURES');
    assert.deepEqual(err.ungrounded, ['94.2']);
    return true;
  });
});

test('a fabricated large integer is rejected too', () => {
  assert.equal(checkGrounded('عدد الطلاب 99,999', PAYLOAD).ungrounded.length, 1);
  assert.equal(checkGrounded('العام 2027 كان أفضل', PAYLOAD).ungrounded.length, 1);
});

test('dates taken from the payload are usable, since their parts are in it', () => {
  assert.equal(checkGrounded('آخر تسليم 2026-09-24 14:02', PAYLOAD).ok, true);
});

test('small integers are not treated as claims', () => {
  // List markers, row numbers and "أعلى 5" limits: flagging these would make the
  // guard unusably noisy, so only 3+ digit / decimal / percent figures count.
  for (const text of ['أعلى 5 طلاب', '1. الطالب الأول', '#3 من القائمة', 'آخر 7 أيام']) {
    assert.equal(checkGrounded(text, PAYLOAD).ok, true, `expected "${text}" to pass`);
  }
  assert.deepEqual(extractFigures('أعلى 5 طلاب').length, 0);
});

test('the ratio→percent transform our own renderers apply is understood', () => {
  // AI confidence arrives as 0.9 and the template prints 90%.
  assert.equal(checkGrounded('متوسط الثقة 90%', PAYLOAD).ok, true);
  assert.equal(checkGrounded('متوسط الثقة 0.9', PAYLOAD).ok, true);
  // ...but a different percentage for the same field is still a fabrication.
  assert.equal(checkGrounded('متوسط الثقة 92%', PAYLOAD).ok, false);
});

test('Arabic decimal separators are understood', () => {
  assert.equal(checkGrounded('نسبة النجاح ٨٣٫٣٪', PAYLOAD).ok, true);
});

test('an answer with no figures at all passes trivially', () => {
  const result = checkGrounded('لا توجد بيانات مطابقة.', PAYLOAD);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 0);
});

test('multiple payloads are all considered', () => {
  assert.equal(checkGrounded('النافذة 900 يوم', [{ windowDays: 900 }]).ok, true);
  assert.equal(checkGrounded('النافذة 901 يوم', [{ windowDays: 900 }]).ok, false);
});
