// tests/cors-guard.test.js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

function runEnvCheck(envOverrides) {
  return spawnSync(
    process.execPath,
    ['-e', "require('./src/config/env.js')"],
    {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        JWTSECRET: 'a_real_valid_secret_that_is_long_enough_1234567890',
        ADMIN_PASSWORD: 'admin_test_password_123',
        BUNNY_STREAM_LIBRARY_ID: '12345',
        BUNNY_STREAM_API_KEY: 'test-api-key',
        BUNNY_STREAM_READ_ONLY_API_KEY: 'test-ro-key',
        BUNNY_STREAM_TOKEN_KEY: 'test-token-key',
        REFRESH_TOKEN_SECRET: 'a_different_real_valid_refresh_secret_987654321',
        ...envOverrides,
      },
      encoding: 'utf8',
    }
  );
}

describe('env.js CORS wildcard startup guard', () => {
  it('rejects wildcard origin in production (https://*.vercel.app)', () => {
    const res = runEnvCheck({
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://*.vercel.app',
    });
    assert.equal(res.status, 1, 'Process should exit with code 1');
    assert.match(
      res.stderr,
      /\[FATAL\] Wildcard origin 'https:\/\/\*\.vercel\.app' in FRONTEND_URL is forbidden in production/
    );
  });

  it('rejects naked wildcard origin in production (*)', () => {
    const res = runEnvCheck({
      NODE_ENV: 'production',
      FRONTEND_URL: '*',
    });
    assert.equal(res.status, 1, 'Process should exit with code 1');
    assert.match(
      res.stderr,
      /\[FATAL\] Wildcard origin '\*' in FRONTEND_URL is forbidden in production/
    );
  });

  it('accepts exact comma-separated origins in production', () => {
    const res = runEnvCheck({
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://teacherdomain.com,https://admin.teacherdomain.com',
    });
    assert.doesNotMatch(res.stderr, /Wildcard origin/);
  });

  it('permits wildcard origin when NODE_ENV is development', () => {
    const res = runEnvCheck({
      NODE_ENV: 'development',
      FRONTEND_URL: 'https://*.vercel.app',
    });
    assert.doesNotMatch(res.stderr, /Wildcard origin/);
  });
});
