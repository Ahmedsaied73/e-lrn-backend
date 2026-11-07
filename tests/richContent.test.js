'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  looksRich,
  parseRich,
  serializeRich,
  isEmptyRich,
  hasMath,
  normalizeMathLatex,
  hasPlaceholder,
  toGraderText,
  toPlainPreview,
  validateRich,
  balancedBraces,
  RICH_LIMITS,
} = require('../src/lib/richContent');

const {
  subjectProfile,
  resolveEffectiveFormat,
  PROFILES,
} = require('../src/lib/subjectProfile');

const fixturesPath = path.join(__dirname, '../src/lib/richContent/rich-contract-fixtures.json');
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

test('richContent: plain fixtures round-trip and validation', () => {
  for (const plain of fixtures.plain) {
    assert.equal(looksRich(plain), false, `looksRich should be false for: ${plain}`);
    const parsed = parseRich(plain);
    assert.equal(parsed.v, 1);
    if (!plain) {
      assert.deepEqual(parsed.blocks, []);
      assert.equal(serializeRich(parsed.blocks), '');
      assert.equal(isEmptyRich(plain), true);
    } else {
      assert.equal(parsed.blocks.length, 1);
      assert.equal(parsed.blocks[0].t, 'text');
      assert.equal(parsed.blocks[0].v, plain);
      assert.equal(serializeRich(parsed.blocks), plain);
      assert.equal(isEmptyRich(plain), false);
    }
    assert.equal(hasMath(plain), false);
    assert.equal(toGraderText(plain), plain);

    const val = validateRich(plain);
    assert.equal(val.ok, true, `validateRich should pass plain text: ${plain}`);
  }
});

test('richContent: rich fixtures parse, validate, and serialize', () => {
  for (const item of fixtures.rich) {
    assert.equal(looksRich(item.raw), true, `looksRich should be true for: ${item.raw}`);
    const parsed = parseRich(item.raw);
    assert.deepEqual(parsed.blocks, item.blocks, `Blocks mismatch for: ${item.raw}`);
    assert.equal(hasMath(item.raw), true, `hasMath should be true for: ${item.raw}`);

    const serialized = serializeRich(parsed.blocks);
    const reParsed = parseRich(serialized);
    assert.deepEqual(reParsed.blocks, item.blocks, `Round-trip mismatch for: ${item.raw}`);

    const val = validateRich(item.raw);
    assert.equal(val.ok, true, `Validation failed on rich fixture: ${item.raw} with code: ${val.code}`);

    const graderText = toGraderText(item.raw);
    assert.ok(typeof graderText === 'string' && graderText.length > 0);
  }
});

test('richContent: invalid fixtures return expected error codes', () => {
  for (const item of fixtures.invalid) {
    const val = validateRich(item.raw);
    assert.equal(val.ok, false, `Expected validation failure for: ${item.raw}`);
    assert.equal(val.code, item.code, `Expected error code ${item.code} but got ${val.code} for: ${item.raw}`);
  }
});

test('richContent: boundary checks and limits', () => {
  // maxTextChars (4000)
  const validText = 'a'.repeat(RICH_LIMITS.maxTextChars);
  const tooLongText = 'a'.repeat(RICH_LIMITS.maxTextChars + 1);
  const envTextOk = JSON.stringify({ v: 1, blocks: [{ t: 'text', v: validText }] });
  const envTextTooLong = JSON.stringify({ v: 1, blocks: [{ t: 'text', v: tooLongText }] });
  assert.equal(validateRich(envTextOk).ok, true);
  assert.equal(validateRich(envTextTooLong).code, 'RICH_TOO_LARGE');

  // maxMathChars (2000)
  const validMath = 'x+'.repeat(999) + 'x'; // 1999 chars
  const tooLongMath = 'x+'.repeat(1001); // 2002 chars
  const envMathOk = JSON.stringify({ v: 1, blocks: [{ t: 'math', v: validMath }] });
  const envMathTooLong = JSON.stringify({ v: 1, blocks: [{ t: 'math', v: tooLongMath }] });
  assert.equal(validateRich(envMathOk).ok, true);
  assert.equal(validateRich(envMathTooLong).code, 'RICH_TOO_LARGE');

  // maxChemChars (500)
  const validChem = 'H2O + '.repeat(80) + 'H2O'; // 483 chars
  const tooLongChem = 'H2O + '.repeat(90); // 540 chars
  const envChemOk = JSON.stringify({ v: 1, blocks: [{ t: 'chem', v: validChem }] });
  const envChemTooLong = JSON.stringify({ v: 1, blocks: [{ t: 'chem', v: tooLongChem }] });
  assert.equal(validateRich(envChemOk).ok, true);
  assert.equal(validateRich(envChemTooLong).code, 'RICH_TOO_LARGE');

  // maxBlocks (60)
  const sixtyBlocks = Array.from({ length: 60 }, (_, i) => ({ t: 'text', v: `Line ${i}` }));
  const sixtyOneBlocks = Array.from({ length: 61 }, (_, i) => ({ t: 'text', v: `Line ${i}` }));
  assert.equal(validateRich(JSON.stringify({ v: 1, blocks: sixtyBlocks })).ok, true);
  assert.equal(validateRich(JSON.stringify({ v: 1, blocks: sixtyOneBlocks })).code, 'RICH_TOO_LARGE');

  // maxTotalChars (20000)
  const hugeRaw = '{"v":1,"blocks":[' + ' '.repeat(RICH_LIMITS.maxTotalChars + 10) + ']}';
  assert.equal(validateRich(hugeRaw).code, 'RICH_TOO_LARGE');

  // Non-string input
  assert.equal(validateRich(null).code, 'RICH_BAD_FORMAT');
  assert.equal(validateRich({}).code, 'RICH_BAD_FORMAT');
});

test('richContent: balancedBraces helper', () => {
  assert.equal(balancedBraces('H2O'), true);
  assert.equal(balancedBraces('{a\\{b\\}c}'), true);
  assert.equal(balancedBraces('{\\}'), false);
  assert.equal(balancedBraces('{'), false);
  assert.equal(balancedBraces('}'), false);
  assert.equal(balancedBraces('}{'), false);
});

test('richContent: normalizeMathLatex and placeholders', () => {
  assert.equal(hasPlaceholder('\\frac{\\placeholder{}}{2}'), true);
  assert.equal(hasPlaceholder('\\frac{1}{2}'), false);
  assert.equal(normalizeMathLatex('\\frac{\\placeholder{num}}{\\placeholder{den}}'), '\\frac{{}}{{}}');
  assert.equal(normalizeMathLatex('x + \\placeholder{}'), 'x + {}');
});

test('richContent: toPlainPreview', () => {
  const preview = toPlainPreview('{"v":1,"blocks":[{"t":"text","v":"Hello"},{"t":"math","v":"x^2"}]}', 20);
  assert.equal(preview, 'Hello x^2');

  const longRaw = '{"v":1,"blocks":[{"t":"text","v":"' + 'word '.repeat(30) + '"}]}';
  const longPreview = toPlainPreview(longRaw, 25);
  assert.ok(longPreview.endsWith('…'));
  assert.ok(longPreview.length <= 25);
});

test('subjectProfile: 10-cell matrix (subject × locale)', () => {
  const subjects = ['MATH', 'PHYSICS', 'CHEMISTRY', 'ARABIC', 'ENGLISH'];
  const locales = ['ar', 'en'];

  for (const subj of subjects) {
    for (const locale of locales) {
      // locale is ignored: subjectProfile only takes subject
      const profile = subjectProfile(subj);
      assert.deepEqual(profile, PROFILES[subj], `Mismatch for ${subj} with locale ${locale}`);
    }
  }
});

test('subjectProfile: Arabic names and aliases', () => {
  assert.deepEqual(subjectProfile('رياضيات'), PROFILES.MATH);
  assert.deepEqual(subjectProfile('رياضة'), PROFILES.MATH);
  assert.deepEqual(subjectProfile('فيزياء'), PROFILES.PHYSICS);
  assert.deepEqual(subjectProfile('الكيمياء'), PROFILES.CHEMISTRY);
  assert.deepEqual(subjectProfile('اللغة العربية'), PROFILES.ARABIC);
  assert.deepEqual(subjectProfile('اللغة الإنجليزية'), PROFILES.ENGLISH);
});

test('subjectProfile: unknown and fallback behavior', () => {
  const fallback = subjectProfile('HISTORY');
  assert.equal(fallback.defaultFormat, 'PLAIN');
  assert.equal(fallback.allowChem, false);

  const fallbackNull = subjectProfile(null);
  assert.equal(fallbackNull.defaultFormat, 'PLAIN');
  assert.equal(fallbackNull.allowChem, false);
});

test('subjectProfile: resolveEffectiveFormat overrides and fallbacks', () => {
  // Explicit PLAIN on MATH deployment stays PLAIN
  assert.equal(resolveEffectiveFormat('PLAIN', 'MATH'), 'PLAIN');

  // Explicit RICH on ARABIC deployment stays RICH
  assert.equal(resolveEffectiveFormat('RICH', 'ARABIC'), 'RICH');

  // NULL on MATH deployment auto-activates to RICH
  assert.equal(resolveEffectiveFormat(null, 'MATH'), 'RICH');
  assert.equal(resolveEffectiveFormat(undefined, 'MATH'), 'RICH');

  // NULL on ARABIC deployment defaults to PLAIN
  assert.equal(resolveEffectiveFormat(null, 'ARABIC'), 'PLAIN');
  assert.equal(resolveEffectiveFormat(undefined, 'ARABIC'), 'PLAIN');
});
