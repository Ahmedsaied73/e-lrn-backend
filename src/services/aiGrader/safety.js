'use strict';

/**
 * safety.js — post-verdict safety gates (FR-14, FR-15, FR-16, FR-18).
 *
 * Every gate returns { pass: true } or { pass: false, reason, details }.
 * Any failing gate routes the job to NEEDS_REVIEW(reason) with the AI's
 * suggested verdict preserved for one-click teacher approval.
 */

const INJECTION_PATTERNS = [
  /تجاهل\s*(كل\s*)?التعليمات/i,
  /الدرجة\s*النهائية/i,
  /اعطني\s*(الدرجة|علامة)\s*كاملة/i,
  /ignore\s*(all\s*)?(previous|prior)\s*(instructions?|rules?)/i,
  /you\s*are\s*(now|actually)\s+/i,
  /system\s*prompt/i,
  /override\s*(score|grade|confidence)/i,
  /\bscore\s*:\s*\d+/i,
];

function checkInjection(studentAnswer) {
  if (typeof studentAnswer !== 'string') return { pass: true };
  for (const p of INJECTION_PATTERNS) {
    if (p.test(studentAnswer)) {
      return { pass: false, reason: 'INJECTION_SUSPECT', details: p.source };
    }
  }
  return { pass: true };
}

function ngrams(text, n) {
  const words = String(text || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length < n) return [];
  const out = [];
  for (let i = 0; i <= words.length - n; i++) {
    out.push(words.slice(i, i + n).join(' '));
  }
  return out;
}

function checkFeedbackLeak(feedback, modelAnswer, ngramSize = 5, threshold = 0.3) {
  if (!feedback || !modelAnswer) return { pass: true };
  const fbNgrams = new Set(ngrams(feedback, ngramSize));
  const maNgrams = new Set(ngrams(modelAnswer, ngramSize));
  if (maNgrams.size === 0 || fbNgrams.size === 0) return { pass: true };
  const overlap = [...fbNgrams].filter((g) => maNgrams.has(g)).length;
  const ratio = overlap / maNgrams.size;
  if (ratio > threshold) {
    return { pass: false, reason: 'FEEDBACK_LEAK', details: `overlap ${(ratio * 100).toFixed(1)}%` };
  }
  return { pass: true };
}

function checkBorderline(attemptScoreSoFar, thisEssayScore, totalPoints, passingScore, margin = 0.05) {
  if (!totalPoints || totalPoints <= 0 || typeof passingScore !== 'number') return { pass: true };
  const projectedPercent = (attemptScoreSoFar + thisEssayScore) / totalPoints;
  const passThreshold = passingScore / 100;
  if (Math.abs(projectedPercent - passThreshold) <= margin) {
    return {
      pass: false,
      reason: 'BORDERLINE_PASS',
      details: `projected ${(projectedPercent * 100).toFixed(1)}%, pass at ${passingScore}%`,
    };
  }
  return { pass: true };
}

function checkAuditSample(rate = 0.05) {
  if (Math.random() < rate) {
    return { pass: false, reason: 'AUDIT_SAMPLE', details: `sampled at ${rate * 100}%` };
  }
  return { pass: true };
}

function runSafetyGates({
  studentAnswer,
  modelAnswer,
  verdict,
  confidenceThreshold = 0.8,
  attemptScoreSoFar = 0,
  totalPoints = 0,
  passingScore = 50,
  auditRate = 0.05,
}) {
  const inj = checkInjection(studentAnswer);
  if (!inj.pass) return inj;

  const leak = checkFeedbackLeak(verdict.feedback, modelAnswer);
  if (!leak.pass) return leak;

  if (verdict.confidence < confidenceThreshold) {
    return {
      pass: false,
      reason: 'LOW_CONFIDENCE',
      details: `confidence ${verdict.confidence} < ${confidenceThreshold}`,
    };
  }

  const borderline = checkBorderline(attemptScoreSoFar, verdict.score, totalPoints, passingScore);
  if (!borderline.pass) return borderline;

  const audit = checkAuditSample(auditRate);
  if (!audit.pass) return audit;

  return { pass: true };
}

module.exports = {
  checkInjection,
  checkFeedbackLeak,
  checkBorderline,
  checkAuditSample,
  runSafetyGates,
};
