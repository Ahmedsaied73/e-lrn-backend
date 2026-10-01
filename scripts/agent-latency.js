'use strict';
/**
 * agent-latency.js — where the milliseconds of an agent turn actually go.
 *
 * WHY THIS EXISTS: "the agent feels slow" is not actionable. The numbers that ARE
 * actionable came from this kind of probe: one round trip to this deployment's
 * Supabase pooler costs ~355ms, so a turn doing four SEQUENTIAL persistence writes
 * cannot be faster than ~1.4s however fast the model is. That is what turned "the
 * agent is slow" into "the agent does four sequential round trips" — and it is what
 * justified collapsing them to one.
 *
 * A committed script matters because the number drifts with the deployment: the pool
 * sits in another region, so re-measuring is the only way to know today's cost.
 *
 *   node scripts/agent-latency.js
 *
 * Env: AGENT_LATENCY_PORT (default 3107), AGENT_LATENCY_RUNS (default 5).
 *
 * It asserts nothing — this is a measurement, not a gate. It does clean up after
 * itself and prints the leftover count, because a benchmark that fills the admin's
 * sidebar is worse than no benchmark.
 */

process.chdir(__dirname + '/..');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.AGENT_LATENCY_PORT) || 3107;
const BASE = `http://127.0.0.1:${PORT}`;
const RUNS = Math.max(1, Number(process.env.AGENT_LATENCY_RUNS) || 5);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { createToken } = require('../src/utils.js');
const config = require('../src/config/env.js');
const prisma = require('../src/config/db');

const ADMIN_COOKIE = `accessToken=${createToken(
  { id: 1, email: 'admin@elearning.com', name: 'T', role: 'ADMIN' },
  config.jwt.secret
)}`;

const createdConversations = [];

async function waitForHealth(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.status === 200) return true;
    } catch { /* not up yet */ }
    await sleep(750);
  }
  return false;
}

async function call(method, path, body) {
  const started = Date.now();
  const res = await fetch(BASE + path, {
    method,
    headers: { Cookie: ADMIN_COOKIE, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = Date.now() - started;
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { ms, status: res.status, json };
}

async function repeat(fn, times) {
  const out = [];
  for (let i = 0; i < times; i += 1) out.push(await fn());
  return out;
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, min: sorted[0], p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] };
}

const fmt = (s) => `n=${s.n} min=${s.min}ms p50=${s.p50}ms p90=${s.p90}ms max=${s.max}ms`;

async function main() {
  const child = spawn(process.execPath, ['app.js'], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: process.env.NODE_ENV || 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let bootLog = '';
  child.stdout.on('data', (d) => { bootLog += d; });
  child.stderr.on('data', (d) => { bootLog += d; });

  const report = [];
  try {
    if (!(await waitForHealth())) throw new Error(`server did not become healthy on ${BASE}\n${bootLog.slice(-800)}`);
    console.log(`agent latency probe — ${BASE} (${RUNS} samples per probe)\n`);

    // The floor: framework + auth, none of our own database work.
    const health = await repeat(() => call('GET', '/health'), RUNS);
    report.push(['GET /health (framework floor)', stats(health.map((r) => r.ms))]);

    const list = await repeat(() => call('GET', '/admin/agent/conversations'), RUNS);
    report.push(['GET /admin/agent/conversations (sidebar)', stats(list.map((r) => r.ms))]);

    // A new conversation, then a follow-up: the two paths Phase 4.5 changed.
    const first = await call('POST', '/admin/agent/ask', { question: 'توزيع الطلاب على الصفوف' });
    const firstId = first.json && first.json.conversationId;
    if (Number.isSafeInteger(firstId)) {
      createdConversations.push(firstId);
      const moreNew = await repeat(() => call('POST', '/admin/agent/ask', { question: 'ملخص الإيرادات' }), RUNS - 1);
      for (const r of moreNew) {
        if (Number.isSafeInteger(r.json && r.json.conversationId)) createdConversations.push(r.json.conversationId);
      }
      report.push(['POST /ask (deterministic, NEW conversation)', stats([first.ms, ...moreNew.map((r) => r.ms)])]);

      const same = await repeat(
        () => call('POST', '/admin/agent/ask', { question: 'توزيع الطلاب على الصفوف', conversationId: firstId }),
        RUNS
      );
      report.push(['POST /ask (deterministic, EXISTING conversation)', stats(same.map((r) => r.ms))]);

      const history = await repeat(() => call('GET', `/admin/agent/conversations/${firstId}/messages`), RUNS);
      report.push(['GET /conversations/:id/messages', stats(history.map((r) => r.ms))]);
    } else {
      console.log('!! the deterministic ask returned no conversationId; skipping the turn probes');
    }

    // The 400 path: validation before any work. This is what the framework costs.
    const invalid = await repeat(() => call('POST', '/admin/agent/ask', {}), RUNS);
    report.push(['POST /ask (400 validation, no work)', stats(invalid.map((r) => r.ms))]);

    const width = Math.max(...report.map(([label]) => label.length));
    for (const [label, s] of report) console.log(`  ${label.padEnd(width)}  ${fmt(s)}`);

    const ask = report.find(([label]) => label.includes('NEW conversation'));
    if (ask) {
      console.log(
        `\n  A new-conversation turn is ~${ask[1].p50}ms p50. Phase 4.5 collapsed its sequential\n` +
        '  persistence writes from 4-5 round trips to 1; the rest is the tool query and the render.'
      );
    }
  } finally {
    if (createdConversations.length) {
      const removed = await prisma.agentConversation.deleteMany({ where: { id: { in: createdConversations } } });
      console.log(`\n  cleanup: deleted ${removed.count} conversation(s) created by this probe`);
    }
    const leftover = createdConversations.length
      ? await prisma.agentConversation.count({ where: { id: { in: createdConversations } } })
      : 0;
    console.log(`  net-zero: ${leftover} probe conversation(s) remain`);
    child.kill();
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`agent latency probe failed: ${err.message}`);
    process.exit(1);
  });

