'use strict';

/**
 * Quiz configuration constants.
 * Single source of truth � imported by quizService, quizController, and quizRoutes.
 */

/** Whitelisted SurveyJS question types the platform accepts. */
const ALLOWED_QUESTION_TYPES = ['radiogroup', 'comment', 'html', 'image'];

/** Maximum serialised surveyJson size in bytes (256 KB). */
const MAX_SURVEY_JSON_BYTES = 262144;

/** Network grace period (seconds) added on top of deadlineAt before a late submit is rejected. */
const GRACE_SEC = 10;

/** Default max quiz retakes per student (overridable per-quiz via Quiz.maxAttempts). */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * How old an UNTIMED in-progress attempt must be before it is considered
 * abandoned. On the next start, such an attempt is auto-submitted with its
 * saved responses (instead of resumed), and a fresh attempt is created.
 */
const STALE_ATTEMPT_MS = 30 * 60 * 1000; // 30 minutes

/** Attempt statuses � kept as plain strings matching the Prisma enum. */
const STATUS = {
  IN_PROGRESS: 'IN_PROGRESS',
  SUBMITTED: 'SUBMITTED',
  GRADING: 'GRADING',
  GRADED: 'GRADED',
  EXPIRED: 'EXPIRED',
};

module.exports = { ALLOWED_QUESTION_TYPES, MAX_SURVEY_JSON_BYTES, GRACE_SEC, DEFAULT_MAX_ATTEMPTS, STALE_ATTEMPT_MS, STATUS };
