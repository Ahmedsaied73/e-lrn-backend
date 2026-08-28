'use strict';

/**
 * Quiz configuration constants.
 * Single source of truth — imported by quizService, quizController, and quizRoutes.
 */

/** Whitelisted SurveyJS question types the platform accepts. */
const ALLOWED_QUESTION_TYPES = ['radiogroup', 'comment', 'html', 'image'];

/** Maximum serialised surveyJson size in bytes (256 KB). */
const MAX_SURVEY_JSON_BYTES = 262144;

/** Network grace period (seconds) added on top of deadlineAt before a late submit is rejected. */
const GRACE_SEC = 10;

/** Attempt statuses — kept as plain strings matching the Prisma enum. */
const STATUS = {
  IN_PROGRESS: 'IN_PROGRESS',
  SUBMITTED: 'SUBMITTED',
  GRADING: 'GRADING',
  GRADED: 'GRADED',
  EXPIRED: 'EXPIRED',
};

module.exports = { ALLOWED_QUESTION_TYPES, MAX_SURVEY_JSON_BYTES, GRACE_SEC, STATUS };
