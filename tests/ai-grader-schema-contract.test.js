'use strict';

// Standalone runs (`node --test tests/ai-grader-schema-contract.test.js`) must
// see the same DATABASE_URL as the rest of the suite, which is normally loaded
// by app.js through src/config/env.js.
require('dotenv').config();

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../src/config/db');

describe('AI grader schema contract', () => {
  after(async () => {
    await prisma.$disconnect();
  });

  it('has all eight hardening columns on AiGradingJob', async () => {
    const rows = await prisma.$queryRaw`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'AiGradingJob'
    `;
    const names = rows.map((r) => r.column_name);
    for (const col of [
      'reason', 'leaseUntil', 'nextRunAt', 'appliedAt',
      'inputHash', 'criteriaBreakdown', 'tokensIn', 'tokensOut',
    ]) {
      assert.ok(names.includes(col), `missing column ${col}`);
    }
  });

  it('has all five job states and no legacy states in use', async () => {
    const rows = await prisma.$queryRaw`
      SELECT unnest(enum_range(NULL::"AiGradingJobStatus"))::text AS value
    `;
    const values = rows.map((r) => r.value);
    for (const state of ['PENDING', 'RUNNING', 'DONE_APPLIED', 'SYSTEM_GRADED', 'NEEDS_REVIEW']) {
      assert.ok(values.includes(state), `missing enum value ${state}`);
    }
    const legacy = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS count FROM "AiGradingJob" WHERE status::text IN ('DONE', 'FAILED')
    `;
    assert.equal(legacy[0].count, 0);
  });

  it('has aiReviewMode on Quiz and both lookup indexes', async () => {
    const quizCols = await prisma.$queryRaw`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Quiz'
    `;
    assert.ok(quizCols.some((r) => r.column_name === 'aiReviewMode'), 'missing column aiReviewMode');

    const indexes = await prisma.$queryRaw`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'AiGradingJob'
    `;
    const names = indexes.map((r) => r.indexname);
    assert.ok(names.includes('AiGradingJob_status_nextRunAt_idx'), 'missing index AiGradingJob_status_nextRunAt_idx');
    assert.ok(names.includes('AiGradingJob_inputHash_idx'), 'missing index AiGradingJob_inputHash_idx');
  });
});
