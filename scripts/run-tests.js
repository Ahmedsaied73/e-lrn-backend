'use strict';
/**
 * Self-hosting test runner.
 *
 * Spins up the real Express server on a dedicated port, waits for `/health` to
 * report DB-up, runs the node:test suite against it, then tears the server
 * down. Makes `npm test` work with zero manual setup (no "server must already
 * be running on :3005") — and CI-friendly for the same reason.
 *
 *   node scripts/run-tests.js
 *
 * Env overrides:
 *   TEST_PORT      port for the spawned server (default 3106; avoids clashes
 *                  with a local `npm run dev` on 3005)
 *   TEST_BASE_URL  used to point the suite at the spawned server (default
 *                  derived from TEST_PORT)
 */

process.chdir(__dirname + '/..');
const { spawn } = require('node:child_process');

const TEST_PORT = Number(process.env.TEST_PORT) || 3106;
const BASE_URL = process.env.TEST_BASE_URL || `http://127.0.0.1:${TEST_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url + '/health');
      if (r.status === 200) return true;
    } catch { /* not up yet */ }
    await sleep(750);
  }
  return false;
}

async function main() {
  const child = spawn(process.execPath, ['app.js'], {
    env: { ...process.env, PORT: String(TEST_PORT), NODE_ENV: process.env.NODE_ENV || 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let bootLog = '';
  child.stdout.on('data', (d) => { bootLog += d; });
  child.stderr.on('data', (d) => { bootLog += d; });
  if (process.env.RUNNER_VERBOSE) { child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); }

  let serverPid = child.pid;
  const teardown = () => {
    try { if (child && !child.killed) child.kill(); } catch { /* already gone */ }
  };
  process.on('exit', teardown);
  process.on('SIGINT', () => { teardown(); process.exit(130); });
  process.on('SIGTERM', () => { teardown(); process.exit(143); });

  try {
    const healthy = await waitForHealth(BASE_URL);
    if (!healthy) {
      console.error('[tests] server did not become healthy on', BASE_URL, '— boot output:\n', bootLog.slice(-2000));
      teardown();
      process.exit(1);
    }
    console.log(`[tests] server healthy on ${BASE_URL} (pid ${serverPid})`);

    const test = spawn(process.execPath, ['--test', 'tests/**/*.test.js'], {
      env: { ...process.env, TEST_BASE_URL: BASE_URL },
      stdio: 'inherit',
      windowsHide: true,
    });
    const { status } = await new Promise((resolve) => {
      test.on('exit', (code) => resolve({ status: code === null ? 1 : code }));
    });
    teardown();
    process.exit(status);
  } catch (err) {
    console.error('[tests] harness error:', err);
    teardown();
    process.exit(1);
  }
}

main();