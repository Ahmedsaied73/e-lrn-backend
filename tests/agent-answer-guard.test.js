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

/**
 * No evidence, no figures.
 *
 * WHY: the 3-digit threshold exists so list markers and row numbers do not trip the
 * guard. But when a turn calls NO tool at all, there is no payload to tell "row 3"
 * apart from "there are 3 students" — and a provider-failover turn was caught
 * answering a count question with `tools: []` and a fabricated small number, which the
 * old threshold passed as noise. With no evidence, every integer is fiction until a
 * tool says otherwise, so every integer counts as a claim.
 */
test('an answer produced WITHOUT any tool call may cite no figure at all', () => {
  const toolless = checkGrounded('there are exactly 3 students in the third secondary', []);
  assert.equal(toolless.ok, false, 'a toolless answer must not state a count');
  assert.equal(toolless.ungrounded.length, 1);

  // The same sentence WITH the tool payload is the good answer it was meant to be.
  const grounded = checkGrounded('there are exactly 3 students in the third secondary', [
    { thirdSecondary: 3 },
  ]);
  assert.equal(grounded.ok, true);
});

test('no evidence + no figures still passes (a refusal needs no source)', () => {
  assert.equal(checkGrounded('no suitable tool exists for this question', []).ok, true);
});

test('the no-evidence rule does not make a grounded answer noisier', () => {
  // A row marker in a real, tool-backed table must stay allowed: the whole point of
  // the 3-digit threshold is that this must not become a guard admins learn to ignore.
  const table = '| # | student |\n| 1 | Ahmed |\n| 2 | Sara |\n| 3 | Mohamed |';
  const result = checkGrounded(table, [{ rows: [{ name: 'Ahmed' }, { name: 'Sara' }, { name: 'Mohamed' }] }]);
  assert.equal(result.ok, true);
});


/**
 * Arabic-Indic numerals are figures too.
 *
 * REGRESSION PIN: `\d` in JavaScript matches ASCII 0-9 ONLY, so the figure pattern
 * used to miss every Arabic-Indic numeral (١٢٣, ٨٣٫٣, ١٠٠٪). Since the agent answers
 * in Arabic, that meant most of the figures it writes were never checked at all — a
 * failover turn could claim "بكل ثقة ١٠٠٪" with zero tool payloads and the guard
 * called it clean. The earlier "Arabic decimal separators" test passed for exactly
 * that reason and proved nothing.
 */
test('Arabic-Indic numerals are extracted and checked like ASCII ones', () => {
  // No evidence: an Arabic-Indic percentage is still a claim.
  assert.equal(checkGrounded('نسبة النجاح ١٠٠٪', []).ok, false);
  // Grounded: the same figure written Arabic-Indic, from a 0..1 ratio in the payload.
  assert.equal(checkGrounded('نسبة النجاح ١٠٠٪', [{ confidence: 1 }]).ok, true);
  // A plain integer: allowed when the tool said it, refused when it did not.
  assert.equal(checkGrounded('العدد ١٢٣', [{ count: 123 }]).ok, true);
  assert.equal(checkGrounded('العدد ١٢٣', [{ count: 124 }]).ok, false);
  // The 3-digit threshold applies to Arabic-Indic digits as well, so small integers
  // remain list markers rather than claims when there IS evidence.
  assert.equal(checkGrounded('| 1 | أحمد |', [{ rows: [{ name: 'أحمد' }] }]).ok, true);
});

