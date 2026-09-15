'use strict';

/**
 * quizKeyResolver.js — Pure snapshot resolvers for quiz attempts.
 * Grading/review must use the key frozen at start, not the live quiz row
 * (admins may edit mid-flight). Pre-snapshot rows (quizSnapshot NULL)
 * fall back to the live key — the old behavior.
 * Never throws (malformed snapshot -> live key -> {}).
 */

function resolveAttemptKey(attempt) {
  try {
    const snap = attempt && attempt.quizSnapshot;
    if (snap && snap.answerKey && typeof snap.answerKey === 'object' && !Array.isArray(snap.answerKey)) {
      return snap.answerKey;
    }
    if (attempt && attempt.quiz && attempt.quiz.answerKey) return attempt.quiz.answerKey;
  } catch { /* fall through */ }
  return {};
}

function resolveAttemptSurvey(attempt) {
  try {
    const snap = attempt && attempt.quizSnapshot;
    if (snap && snap.surveyJson && typeof snap.surveyJson === 'object') return snap.surveyJson;
    if (attempt && attempt.quiz && attempt.quiz.surveyJson) return attempt.quiz.surveyJson;
  } catch { /* fall through */ }
  return null;
}

module.exports = {
  resolveAttemptKey,
  resolveAttemptSurvey,
};
