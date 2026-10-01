'use strict';

/**
 * Phase 4 — the grounding guard advises, never blocks (handoff 3.4, Decision #13).
 *
 * The templates cannot invent numbers; a model can. This suite pins which figures
 * are allowed (payload values in their legitimate spellings, dates, the ratio→percent
 * transform, and — new this phase — numbers the admin typed themselves or that rode
 * inside a tool-call argument) and how an invented statistic surfaces: the answer is
 * returned intact with a one-line Arabic caveat and `metadata.unverifiedFigures`
 * populated, never discarded and never thrown.
 */

process.env.REDIS_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalNumber,
  collectAllowed,
  collectPermitted,
  extractFigures,
  checkGrounded,
  withGroundingNote,
  UNVERIFIED_FIGURES_NOTE,
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

test('a fabricated statistic is flagged, and named — then shown, not discarded', () => {
  const answer = 'أعلى دقة تصحيح بلغت 94.2% وهذا ممتاز.';
  const result = checkGrounded(answer, PAYLOAD);
  // Phase 4 (Decision #13): the guard ADVISES — detection is unchanged, disposal is
  // gone. The same figure that Phase 3 threw on is still caught and named here…
  assert.equal(result.ok, false);
  assert.deepEqual(result.ungrounded, ['94.2']);
  // …but the answer is returned INTACT, with one honest caveat, and the figures
  // are recorded on the turn instead of being thrown at the admin as an error.
  const noted = withGroundingNote(answer, result);
  assert.ok(noted.startsWith(answer), 'the model text itself is untouched');
  assert.ok(noted.includes(UNVERIFIED_FIGURES_NOTE), 'exactly one caveat line is appended');
  assert.equal(noted.split(UNVERIFIED_FIGURES_NOTE).length - 1, 1, 'and it appears exactly once');
});

test('a fabricated large integer is flagged, but the answer is shown', () => {
  assert.equal(checkGrounded('عدد الطلاب 99,999', PAYLOAD).ungrounded.length, 1);
  assert.equal(checkGrounded('العام 2027 كان أفضل', PAYLOAD).ungrounded.length, 1);
});

test('numbers the admin typed themselves pass through untouched', () => {
  // Handoff 3.4: the admin's own words are never the model's invention — a figure
  // verbatim in this turn's question is exempt, whatever the payload says.
  const question = 'قارن 2027 بـ 2026 لصف الثالث الثانوي اللي فيه 500 طالب';
  const answer = 'مقارنة 2027 بـ 2026 للـ 500 طالب: لا توجد بيانات كافية.';
  const checked = checkGrounded(answer, PAYLOAD, { question });
  assert.equal(checked.ok, true, `the admin's own figures are not the model's claims: ${checked.ungrounded}`);
  assert.deepEqual(withGroundingNote(answer, checked), answer, 'no caveat when nothing was flagged');

  // Same answer, same payload, no question passed: the figures ARE the model's.
  const flagged = checkGrounded(answer, PAYLOAD);
  assert.equal(flagged.ok, false, 'without the question there is no exemption');
});

test('dates taken from the payload are usable, since their parts are in it', () => {
  assert.equal(checkGrounded('آخر تسليم 2026-09-24 14:02', PAYLOAD).ok, true);
});

test("numbers that rode inside this turn's tool-call arguments are not inventions", () => {
  // Handoff 3.4: the model asked for windowDays 900, so echoing "900 days" back is
  // repeating the request, not hallucinating a figure.
  const toolArgs = [{ windowDays: 900 }, 'a plain string arg'];
  assert.ok(collectPermitted([{ windowDays: 1 }], null, toolArgs).has('900'));
  assert.equal(checkGrounded('النافذة 900 يوم', [{ windowDays: 1 }], { toolArgs }).ok, true);
  // ...but a DIFFERENT number is still a fabrication, even with the exemption in play.
  assert.equal(checkGrounded('النافذة 901 يوم', [{ windowDays: 1 }], { toolArgs }).ok, false);
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
 * Plain conversation: no check, no caveat.
 *
 * Phase 4 (handoff 3.4): a turn where no tool ran is exempt ENTIRELY — it is
 * conversation, not a data claim, and a grounding check with nothing to judge
 * against would only invent flags. This REPLACES the old no-evidence threshold,
 * which treated every small integer as a claim when the payloads were empty.
 */
test('a pure-conversation turn (no tool calls) is never checked at all', () => {
  // The exact sentence the old rule refused now passes untouched.
  const skipped = checkGrounded('there are exactly 3 students in the third secondary', []);
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, 'NO_TOOLS');
  assert.deepEqual(skipped.ungrounded, []);
  assert.deepEqual(withGroundingNote('there are exactly 3 students in the third secondary', skipped),
    'there are exactly 3 students in the third secondary');

  // And a toolless refusal — "no figure I can give you" — passes trivially.
  assert.equal(checkGrounded('no suitable tool exists for this question', []).ok, true);
});

/**
 * The caveat is an answer to a real flag, never decoration.
 *
 * `withGroundingNote` renders the matching `checkGrounded` output and nothing
 * else: no flag means byte-identical text, a flag means exactly one trailing
 * line, and it never doubles up when the model itself already carried the note.
 */
test('a clean answer comes back byte-identical, a flagged one exactly once', () => {
  const clean = checkGrounded('لا توجد بيانات مطابقة.', PAYLOAD);
  assert.equal(clean.ok, true);
  assert.deepEqual(withGroundingNote('لا توجد بيانات مطابقة.', clean), 'لا توجد بيانات مطابقة.');

  const flagged = checkGrounded('عدد الطلاب 99,999', PAYLOAD);
  const once = withGroundingNote('عدد الطلاب 99,999', flagged);
  assert.equal(once.split(UNVERIFIED_FIGURES_NOTE).length - 1, 1);
  // Idempotent: a model or a caller that already appended it cannot double it.
  assert.deepEqual(withGroundingNote(once, flagged), once);
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
 * in Arabic, that meant most of the figures it writes were never checked at all.
 */
test('Arabic-Indic numerals are extracted and checked like ASCII ones', () => {
  // Phase 4: a toolless turn is skipped whichever alphabet it is written in.
  assert.equal(checkGrounded('نسبة النجاح ١٠٠٪', []).ok, true);
  assert.equal(checkGrounded('نسبة النجاح ١٠٠٪', []).skipped, 'NO_TOOLS');
  // Grounded: the same figure written Arabic-Indic, from a 0..1 ratio in the payload.
  assert.equal(checkGrounded('نسبة النجاح ١٠٠٪', [{ confidence: 1 }]).ok, true);
  // A plain integer: allowed when the tool said it, flagged when it did not.
  assert.equal(checkGrounded('العدد ١٢٣', [{ count: 123 }]).ok, true);
  assert.equal(checkGrounded('العدد ١٢٣', [{ count: 124 }]).ok, false);
  assert.deepEqual(checkGrounded('العدد ١٢٣', [{ count: 124 }]).ungrounded, ['١٢٣']);
  // The 3-digit threshold applies to Arabic-Indic digits as well, so small integers
  // remain list markers rather than claims when there IS evidence.
  assert.equal(checkGrounded('| 1 | أحمد |', [{ rows: [{ name: 'أحمد' }] }]).ok, true);
});

