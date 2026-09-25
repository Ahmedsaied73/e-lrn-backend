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
function extractFigures(text) {
  const figures = [];
  const pattern = /(\d[\d,.\u066B\u066C]*)\s*(%|\u066A)?/g;
  let match = pattern.exec(String(text || ''));
  while (match) {
    const raw = match[1];
    const isPercent = Boolean(match[2]);
    const canonical = canonicalNumber(raw);
    if (canonical !== null) {
      const digitsOnly = canonical.replace(/[-.]/g, '');
      const significant = isPercent || canonical.includes('.') || digitsOnly.length >= MIN_SIGNIFICANT_DIGITS;
      if (significant) figures.push({ raw: raw.trim(), canonical, isPercent });
    }
    match = pattern.exec(String(text || ''));
  }
  return figures;
}

/** { ok, ungrounded, checked } — never throws; use assertGrounded to enforce. */
function checkGrounded(answerText, payloads) {
  const allowed = collectAllowed(payloads);
  const figures = extractFigures(answerText);
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
