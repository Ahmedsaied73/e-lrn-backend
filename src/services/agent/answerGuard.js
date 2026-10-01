'use strict';

/**
 * answerGuard.js — advisory grounding check for LLM-written answers (Phase 4).
 *
 * WHY: the deterministic templates cannot invent a number (they only format tool
 * payloads). A model can, fluently. "أعلى دقة تصحيح بلغت 94.2%" reads perfectly
 * and may be pure fiction, so the agentic tier's output is checked against the
 * payloads the tools actually returned before an admin sees it.
 *
 * OUTCOME (Phase 4, handoff 3.4 — Decision #13): the check WARNS, never blocks.
 * `checkGrounded` only reports; `withGroundingNote` appends ONE short Arabic
 * caveat when something was actually flagged. There is no discard, no throw, and
 * no failure code: the worst case for any turn is an answer with a trailing note.
 *
 * WHAT IS CHECKED (and why not "every digit"): figures that could be a claim —
 * three or more digits, any decimal, or anything with a % sign. Bare one/two digit
 * integers are ignored because they are list markers, row numbers and "أعلى 5"
 * limits, and flagging them would make the guard noise that gets switched off.
 * The failure mode we are flagging is a fabricated *statistic*.
 *
 * EXEMPTIONS (handoff 3.4): a figure the admin typed in this turn's own question
 * (their words are never the model's invention); a figure that rode inside a
 * tool-call argument the model sent this turn (it came from the admin or a prior
 * read, not thin air); and any turn where no tool ran at all — plain conversation
 * is never subject to a data-grounding check, so the check returns a skip marker
 * instead of inventing claims from nothing.
 *
 * ALLOWED VARIATIONS: thousands separators, Arabic decimal/thousands marks, and
 * the ratio→percent transform the templates themselves apply (0.9 in a payload
 * may legitimately be written as 90%), so the check does not fight our own
 * formatters.
 */

/** A figure is "significant" (a possible claim) when it matches any of these. */
const MIN_SIGNIFICANT_DIGITS = 3;

/**
 * The one-line caveat (handoff 3.4, exact wording). Appended to the answer only
 * when a figure was actually flagged — never as a standing disclaimer.
 */
const UNVERIFIED_FIGURES_NOTE = '(الرقم ده مش متأكد إنه من بيانات المنصة، اتأكد منه لو مهم)';

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
 * Every figure the answer is allowed to use.
 *
 * Phase 4 sources, in order: the tool payloads (collected by collectAllowed),
 * the tool-call ARGUMENTS the model sent this turn, and the question text the
 * admin sent this turn. The question and the args are someone else's words (the
 * admin's, or a value a tool already returned), so echoing a number from either
 * is never an invention — but they are merged in AFTER the payload scan, and
 * only for this turn, so nothing the admin once typed becomes a permanent fact.
 */
function collectPermitted(payloads, questionText, toolArgs) {
  const permitted = collectAllowed(payloads);
  for (const match of String(questionText || '').match(/[\d٠-٩۰-۹][\d٠-٩۰-۹,.\u066B\u066C]*/g) || []) {
    const canonical = canonicalNumber(match);
    if (canonical !== null) permitted.add(canonical);
  }
  // Tool-call arguments the model sent this turn: numbers echoed back from the
  // request are not invented, and collectAllowed's own traversal collects exactly
  // those (and nothing else) from the args objects.
  if (toolArgs !== undefined && toolArgs !== null) {
    const fromArgs = collectAllowed(Array.isArray(toolArgs) ? toolArgs : [toolArgs]);
    for (const canonical of fromArgs) permitted.add(canonical);
  }
  return permitted;
}
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

/**
 * { ok, ungrounded, checked, skipped } — never throws.
 *
 * Phase 4 (handoff 3.4): the guard ADVISES — it reports what it found, and the
 * caller decides. `options.question` is the admin's raw question text and
 * `options.toolArgs` is the list of this turn's tool-call argument objects; both
 * are new this phase, because neither reached the guard before it.
 *
 * `skipped: 'NO_TOOLS'` replaces the old no-evidence threshold: when no tool ran
 * this turn the answer is ordinary conversation (Decision #3), and a data check
 * that cannot distinguish "table row 3" from "3 students" would only be noise.
 * Everything else — including "١٢٣ طالب" with a tool payload of `count: 124` —
 * behaves exactly as it did before: flagged, named, and returned.
 */
function checkGrounded(answerText, payloads, options = {}) {
  const normalizedPayloads = payloads === undefined || payloads === null ? [] : payloads;
  const ran = (Array.isArray(normalizedPayloads) ? normalizedPayloads : [normalizedPayloads]).filter(
    (payload) => payload !== null && payload !== undefined
  );
  const { question = null, toolArgs = [] } = options || {};

  if (ran.length === 0) {
    // A tool-free turn is plain conversation — exempt entirely (handoff 3.4).
    // Nothing to judge against, so judge nothing.
    return { ok: true, ungrounded: [], checked: 0, skipped: 'NO_TOOLS' };
  }

  const permitted = collectPermitted(ran, question, toolArgs);
  const figures = extractFigures(answerText, MIN_SIGNIFICANT_DIGITS);
  const ungrounded = [];
  for (const figure of figures) {
    if (!permitted.has(figure.canonical)) ungrounded.push(figure.raw);
  }
  return { ok: ungrounded.length === 0, ungrounded, checked: figures.length, skipped: null };
}

/**
 * Appends UNVERIFIED_FIGURES_NOTE once to an answer the guard flagged — and
 * nothing to one it did not. `result` is the matching `checkGrounded` output for
 * this answer; checked statically so the caller cannot note one answer with
 * another's findings. Idempotent: an answer that (or a model that) already
 * carries the note is returned unchanged.
 */
function withGroundingNote(answerText, result) {
  if (!result || result.ok || !Array.isArray(result.ungrounded) || result.ungrounded.length === 0) {
    return String(answerText || '');
  }
  const answer = String(answerText || '');
  if (answer.includes(UNVERIFIED_FIGURES_NOTE)) return answer;
  return `${answer}\n${UNVERIFIED_FIGURES_NOTE}`;
}

module.exports = {
  MIN_SIGNIFICANT_DIGITS,
  UNVERIFIED_FIGURES_NOTE,
  canonicalNumber,
  collectAllowed,
  collectPermitted,
  extractFigures,
  checkGrounded,
  withGroundingNote,
};
