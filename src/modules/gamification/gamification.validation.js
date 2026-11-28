'use strict';

const { z } = require('zod');
const { SLUG_RE } = require('../../utils/slugs');

const CHALLENGE_KINDS = ['MASTERY', 'STREAK_ANSWERS', 'IMPROVE', 'MISTAKES', 'NO_SKIP', 'AI_ESSAY'];

const upsertChallengeSchema = z
  .object({
    kind: z.enum(CHALLENGE_KINDS),
    quizSlug: z.string().regex(SLUG_RE).nullable().optional(),
    title: z.string().trim().min(1).max(100),
    rule: z.string().trim().min(1).max(300),
    masteryPercent: z.number().int().min(50).max(100),
    rewardXp: z.number().int().min(10).max(300),
    enabled: z.boolean().optional().default(true),
  })
  .strict();

module.exports = {
  CHALLENGE_KINDS,
  upsertChallengeSchema,
};
