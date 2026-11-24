'use strict';

const { z } = require('zod');

const extractFieldsSchema = z.object({
  examId: z.coerce.number().int().positive().optional(),
  attemptId: z.coerce.number().int().positive(),
  questionId: z.string().trim().min(1).max(128),
});

const geminiOutputSchema = z.object({
  text: z.string(),
  imageQuality: z.enum(['good', 'blurry', 'dark', 'cropped', 'unreadable']),
  detectedLanguage: z.enum(['ar', 'en', 'mixed', 'math']).catch('mixed'),
  warnings: z.array(z.string()).default([]),
});

const GEMINI_RESPONSE_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    text: { type: 'string' },
    imageQuality: {
      type: 'string',
      enum: ['good', 'blurry', 'dark', 'cropped', 'unreadable'],
    },
    detectedLanguage: {
      type: 'string',
      enum: ['ar', 'en', 'mixed', 'math'],
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['text', 'imageQuality', 'detectedLanguage', 'warnings'],
});

module.exports = {
  extractFieldsSchema,
  geminiOutputSchema,
  GEMINI_RESPONSE_JSON_SCHEMA,
};
