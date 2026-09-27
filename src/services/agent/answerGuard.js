'use strict';

/**
 * answerGuard.js — grounding check for LLM-written answers (Phase 3).
 *
 * WHY: the deterministic templates cannot invent a number (they only format tool
 * payloads). A model can, fluently. "أعلى دقة تصحيح بلغت 94.2%" reads perfectly
 * and may be pure fiction, so the agentic tier's output is checked against the
 * payloads the tools actually returned before it is shown to an admin.
 *
 * WHAT IS CHECKED (and why not "every digit"): figures that could be a claim —
 * three or more digits, any decimal, or anything with a % sign. Bare one/two digit
 * integers are ignored because they are list markers, row numbers and "أعلى 5"
 * limits, and flagging them would make the guard noise that gets switched off.
 * The failure mode we are protecting against is a fabricated *statistic*.
 *
 * ALLOWED VARIATIONS: thousands separators, Arabic decimal/thousands marks, and
 * the ratio→percent transform the templates themselves apply (0.9 in a payload
 * may legitimately be written as 90%), so the check does not fight our own
 * formatters.
 */

/** A figure is "significant" (a possible claim) when it matches any of these. */
const MIN_SIGNIFICANT_DIGITS = 3;

/**
 * The no-evidence threshold (Phase: failover hardening).
 *
 * WHY: a model that answers WITHOUT calling any tool has produced no evidence, and
 * the only way it could know a figure is by inventing it. The 3-digit threshold above
 * exists so list markers and row numbers do not trip the guard — but with zero
 * payloads there is nothing to distinguish "row 3 of a table" from "there are 3
 * students", and the real failure this caught was a turn that answered a count
 * question with no tool call at all. Measured live: a provider failover turn answered
 * "يوجد ثلاثة طلاب فقط" with `tools: []`, and the guard waved it through because "3"
 * is not a significant figure.
 *
 * So: evidence present -> the existing threshold (never noisier than before);
 * evidence absent -> EVERY integer is a claim, because every one of them is fiction
 * until a tool says otherwise.
 */
const NO_EVIDENCE_MIN_DIGITS = 1;

class AnswerGroundingError extends Error {
  constructor(ungrounded) {
    super(`answer contains ${ungrounded.length} figure(s) not present in any tool payload: ${ungrounded.join(', ')}`);
    this.name = 'AnswerGroundingError';
    this.code = 'UNGROUNDED_FIGURES';
    this.ungrounded = ungrounded;
  }
}

/** "1,234.50" / "١٢٣٤٫٥" → "1234.5"; unparseable → null. */
function canonicalNumber(token) {
  if (token === null || token === undefined) return null;
  const cleaned = String(token)
    // Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹) digits to ASCII, because
    // an admin's phone/answers and our own output contain both.
    .replace(/[\u0660-\u0669]/g, (ch) => String(ch.codePointAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (ch) => String(ch.codePointAt(0) - 0x06f0))
    .replace(/[\s,\u066C\u066C]/g, '') // Latin + Arabic thousands separators
    .replace(/\u066B/g, '.'); // Arabic decimal separator
  if (!/\d/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  // String(value) normalizes "1.50" → "1.5" and "-0" → "0" so both sides compare.
  return String(value);
}

/**
 * Every number the answer is allowed to use: all numbers in the payloads, the
 * numbers inside their date/time strings, and the percent form of any 0..1 ratio
 * (which our own renderers produce from confidence values).
 */
function collectAllowed(payloads, allowed = new Set()) {
  const visit = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'number') {
      const canonical = canonicalNumber(value);
      if (canonical === null) return;
      allowed.add(canonical);
      const numeric = Number(canonical);
      if (numeric > 0 && numeric <= 1) {
        const asPercent = canonicalNumber(Math.round(numeric * 1000) / 10);
        if (asPercent !== null) allowed.add(asPercent);
      }
      return;
    }
    if (typeof value === 'string') {
      for (const match of value.match(/\d[\d,.\u066B\u066C]*/g) || []) {
        const canonical = canonicalNumber(match);
        if (canonical !== null) allowed.add(canonical);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object') Object.values(value).forEach(visit);
  };

  (Array.isArray(payloads) ? payloads : [payloads]).forEach(visit);
  return allowed;
}

/** Figures in the answer text that would count as a claim. */
function extractFigures(text, minSignificantDigits = MIN_SIGNIFICANT_DIGITS) {
  const figures = [];
  // BOTH digit alphabets are matched on purpose. `\d` in JavaScript is ASCII 0-9
  // ONLY, so before this the guard could not see a single Arabic-Indic numeral
  // (١٢٣, ٨٣٫٣) - and Arabic is the language this agent actually answers in, so most
  // figures it writes were invisible to the check that exists to catch invented ones.
  // Measured: a failover answer reading "بكل ثقة ١٠٠٪" with zero tool payloads passed
  // as clean, because that figure was never extracted at all.
  const pattern = /([\d٠-٩۰-۹][\d٠-٩۰-۹,.\u066B\u066C]*)\s*(%|\u066A)?/g;
  let match = pattern.exec(String(text || ''));
  while (match) {
    const raw = match[1];
    const isPercent = Boolean(match[2]);
    const canonical = canonicalNumber(raw);
    if (canonical !== null) {
      const digitsOnly = canonical.replace(/[-.]/g, '');
      const significant = isPercent || canonical.includes('.') || digitsOnly.length >= minSignificantDigits;
      if (significant) figures.push({ raw: raw.trim(), canonical, isPercent });
    }
    match = pattern.exec(String(text || ''));
  }
  return figures;
}

/** { ok, ungrounded, checked } — never throws; use assertGrounded to enforce. */
function checkGrounded(answerText, payloads) {
  const allowed = collectAllowed(payloads);
  // The whole point of the guard: a figure is only acceptable if SOME tool said it.
  // The evidence test is "did a tool RUN", not "did a payload contain a digit" — a
  // tool that returns a list of names (no digits) is still evidence, and rendering it
  // as a row-numbered table must not be refused. See NO_EVIDENCE_MIN_DIGITS.
  const ran = (Array.isArray(payloads) ? payloads : [payloads]).filter(
    (payload) => payload !== null && payload !== undefined
  );
  const minDigits = ran.length === 0 ? NO_EVIDENCE_MIN_DIGITS : MIN_SIGNIFICANT_DIGITS;
  const figures = extractFigures(answerText, minDigits);
  const ungrounded = [];
  for (const figure of figures) {
    if (!allowed.has(figure.canonical)) ungrounded.push(figure.raw);
  }
  return { ok: ungrounded.length === 0, ungrounded, checked: figures.length };
}

/** Throws AnswerGroundingError when a figure cannot be traced to a tool payload. */
function assertGrounded(answerText, payloads) {
  const result = checkGrounded(answerText, payloads);
  if (!result.ok) throw new AnswerGroundingError(result.ungrounded);
  return result;
}

module.exports = {
  AnswerGroundingError,
  MIN_SIGNIFICANT_DIGITS,
  canonicalNumber,
  collectAllowed,
  extractFigures,
  checkGrounded,
  assertGrounded,
};
