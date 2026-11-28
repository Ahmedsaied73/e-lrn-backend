'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

describe('Migrations and boot readiness hardening', () => {
  it('20261126000000_ai_grader_hardening does not contain COMMIT; BEGIN; and is split cleanly', () => {
    const part1 = fs.readFileSync(
      path.join(ROOT, 'prisma/migrations/20261126000000_ai_grader_hardening/migration.sql'),
      'utf8'
    );
    assert.ok(!/\bCOMMIT\s*;/i.test(part1), 'Part 1 migration must not commit mid-file');
    assert.ok(!/\bBEGIN\s*;/i.test(part1), 'Part 1 migration must not reopen transaction');
    assert.match(part1, /ADD VALUE IF NOT EXISTS 'DONE_APPLIED'/);

    const part2Path = path.join(ROOT, 'prisma/migrations/20261126010000_ai_grader_hardening_backfill/migration.sql');
    assert.ok(fs.existsSync(part2Path), 'Part 2 backfill migration must exist');
    const part2 = fs.readFileSync(part2Path, 'utf8');
    assert.match(part2, /UPDATE "AiGradingJob"/);
    assert.match(part2, /CREATE INDEX IF NOT EXISTS "AiGradingJob_status_nextRunAt_idx"/);

    const vecPath = path.join(ROOT, 'prisma/migrations/20261127000000_enable_pgvector_if_available/migration.sql');
    assert.ok(fs.existsSync(vecPath), 'pgvector extension migration must exist');
  });

  it('env.js refuses to boot in production with placeholder ADMIN_PASSWORD', () => {
    const res = spawnSync(
      process.execPath,
      ['-e', 'require("./src/config/env")'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          JWTSECRET: 'a_very_real_64_char_secret_value_for_unit_test_0123456789abcdef',
          REFRESH_TOKEN_SECRET: 'b_very_real_64_char_secret_value_for_unit_test_0123456789abcdef',
          ADMIN_PASSWORD: 'CHANGE_ME_INITIAL_STRONG_ADMIN_PASSWORD',
          BUNNY_STREAM_LIBRARY_ID: '123',
          BUNNY_STREAM_API_KEY: 'key',
          BUNNY_STREAM_READ_ONLY_API_KEY: 'ro',
          BUNNY_STREAM_TOKEN_KEY: 'tok',
          SUPABASE_URL: 'https://test.supabase.co',
          SUPABASE_SERVICE_KEY: 'sb_real_key_123456',
        },
        encoding: 'utf8',
      }
    );
    assert.notEqual(res.status, 0, 'Production boot must exit non-zero on placeholder ADMIN_PASSWORD');
    assert.match(res.stderr, /ADMIN_PASSWORD/);
  });

  it('/readyz verifies schema migrations and admin user existence', () => {
    const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    assert.match(appSource, /dbReadinessCheck/);
    assert.match(appSource, /_prisma_migrations/);
    assert.match(appSource, /role:\s*'ADMIN'/);
  });
});
