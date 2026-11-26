'use strict';

/**
 * reviewMode.js — per-quiz AI review mode policy (FR-17).
 *
 * AUTO (default): confident, gate-passing verdicts apply immediately.
 * REVIEW_REQUIRED: every verdict goes to NEEDS_REVIEW(REVIEW_REQUIRED_MODE)
 * with the AI's suggestion preserved for one-click teacher approval.
 */

function shouldAutoApply(quiz) {
  if (quiz && quiz.aiReviewMode === 'REVIEW_REQUIRED') {
    return { apply: false, reason: 'REVIEW_REQUIRED_MODE' };
  }
  return { apply: true };
}

module.exports = { shouldAutoApply };
