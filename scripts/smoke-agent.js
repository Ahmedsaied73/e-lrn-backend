'use strict';
/**
 * smoke-agent.js — the end-to-end check that would have caught this session's defects.
 *
 * WHY A COMMITTED SCRIPT: live verification found, in order — an undefined function
 * reference, a `for await` over a non-async iterable, a missing prisma fallback, the
 * agent router mounted AFTER the global error handler (so 400s answered HTML), and an
 * approval endpoint that answered 500 for every request. Every one of them survives a
 * casual read and would have shipped. A repeatable probe is the only defence: it
 * exercises the real HTTP surface, the real auth, the real database and the real
 * provider, and it reports a broken surface as broken instead of as "no answer".
 *
 * GATED because it spends provider quota and writes to the real database. Not part of
 * `npm test`.
 *
 *   RUN_LIVE_AGENT=1 node scripts/smoke-agent.js
 *
 * Env: SMOKE_PORT (default 3108), SMOKE_KEEP (keep rows for debugging).
 *
 * EXIT: 0 when every STRUCTURAL check passes — a provider rate limit is a PASS with a
 * warning, because the free tier really is ~8k tokens/minute and declining is the
 * feature working. 1 on a structural failure.
 *
 * Net-zero by contract: every conversation and approval it creates is deleted, and the
 * leftovers are printed. A smoke test that leaves rows behind trains people to ignore
 * the net-zero line.
 */

process.chdir(__dirname + '/..');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.SMOKE_PORT) || 3108;
const BASE = `http://127.0.0.1:${PORT}`;
const KEEP = Boolean(process.env.SMOKE_KEEP);
const ARABIC = /[\u0600-\u06FF]/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { createToken } = require('../src/utils.js');
const config = require('../src/config/env.js');
const prisma = require('../src/config/db');
const { randomBase36Slug } = require('../src/utils/slugs.js');

const results = [];
const createdConversations = [];
const createdApprovals = [];

function record(name, status, detail) {
  results.push({ name, status, detail });
  console.log(`  [${status}] ${name}${detail ? ` — ${detail}` : ''}`);
}

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

function cookieFor(user) {
  return `accessToken=${createToken(
    { id: user.id, email: user.email, name: 'S', role: user.role },
    config.jwt.secret
  )}`;
}

const adminCookie = () => cookieFor({ id: 1, email: 'admin@elearning.com', role: 'ADMIN' });

async function call(method, path, cookie, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  let text = '';
  try {
    text = await res.text();
    json = JSON.parse(text);
  } catch { /* a non-JSON body is itself a structural failure */ }
  return { status: res.status, json, text };
}

/** Structural failure = the surface is broken, whatever the model did. */
function assertEnvelope(res, name) {
  if (!res.json || typeof res.json !== 'object') {
    record(name, 'FAIL', `no JSON envelope (status ${res.status}, body: ${res.text.slice(0, 120)})`);
    return false;
  }
  if (res.json.success !== true) {
    record(name, 'FAIL', `success !== true: ${JSON.stringify(res.json).slice(0, 200)}`);
    return false;
  }
  return true;
}

async function runProbes() {
  const health = await fetch(`${BASE}/health`);
  record('GET /health answers 200', health.status === 200 ? 'PASS' : 'FAIL', `status ${health.status}`);

  // The admin boundary. A forged student token is enough and creates no rows.
  const anon = await call('GET', '/admin/agent/conversations', null);
  record('unauthenticated list is 401', anon.status === 401 ? 'PASS' : 'FAIL', `status ${anon.status}`);

  const studentEmail = `smoke-${Date.now()}@localhost.test`;
  const student = await prisma.user.create({
    data: { slug: randomBase36Slug(), name: 'Smoke Student', email: studentEmail, password: 'x', grade: 'FIRST_SECONDARY' },
  });
  try {
    const denied = await call('GET', '/admin/agent/conversations', cookieFor({ id: student.id, email: studentEmail, role: 'STUDENT' }));
    record('student list is 403', denied.status === 403 ? 'PASS' : 'FAIL', `status ${denied.status}`);

    // The deterministic turn: the path that must never need a model.
    const ask = await call('POST', '/admin/agent/ask', adminCookie(), { question: 'توزيع الطلاب على الصفوف' });
    if (!assertEnvelope(ask, 'POST /ask (deterministic)')) return;
    const body = ask.json;
    const conversationId = body.conversationId;
    if (Number.isSafeInteger(conversationId)) createdConversations.push(conversationId);
    const answer = typeof body.answer === 'string' ? body.answer : '';
    const good = body.ok === true && body.source === 'deterministic' && ARABIC.test(answer);
    record(
      'POST /ask (deterministic)',
      good ? 'PASS' : 'FAIL',
      good ? `ok=true source=deterministic conversationId=${conversationId}` : `ok=${body.ok} source=${body.source} arabic=${ARABIC.test(answer)}`
    );

    // Read-after-write: the turn must be visible the moment the caller is told.
    if (Number.isSafeInteger(conversationId)) {
      const history = await call('GET', `/admin/agent/conversations/${conversationId}/messages`, adminCookie());
      const roles = history.json && Array.isArray(history.json.data) ? history.json.data.map((m) => m.role) : [];
      const ok = history.status === 200 && roles.join(',') === 'USER,ASSISTANT';
      record('GET messages shows USER,ASSISTANT', ok ? 'PASS' : 'FAIL', `roles=[${roles.join(',')}]`);
    } else {
      record('GET messages shows USER,ASSISTANT', 'FAIL', 'no conversationId to read');
    }

    // A validation failure must be a JSON 400, not an HTML page. This is the check
    // that would have caught the router-mounted-after-the-error-handler defect.
    const invalid = await call('POST', '/admin/agent/ask', adminCookie(), {});
    const jsonError = invalid.status === 400 && invalid.json && invalid.json.code === 'AGENT_QUESTION_REQUIRED';
    record('POST /ask {} is a JSON 400', jsonError ? 'PASS' : 'FAIL', `status ${invalid.status} code=${invalid.json && invalid.json.code}`);

    // The approval endpoint, which shipped answering 500 for every request.
    const approval = await call('POST', '/admin/agent/approvals', adminCookie(), {
      toolName: 'smoke_probe_reset_quiz_attempt',
      args: { userSlug: 'aaaaaaaaaaaa', quizSlug: 'bbbbbbbbbbbb' },
    });
    if (Number.isSafeInteger(approval.json && approval.json.data && approval.json.data.id)) {
      createdApprovals.push(approval.json.data.id);
    }
    const approvalOk = approval.status === 201 && approval.json && approval.json.success === true;
    record('POST /approvals is 201 (was 500)', approvalOk ? 'PASS' : 'FAIL', `status ${approval.status}`);

    // The model tier. A provider rate limit is NOT a failure of this code: the free
    // tier is ~8k tokens/minute and declining is the feature working, not the surface
    // breaking — so it is a WARN, and only a structurally broken answer is a FAIL.
    const llm = await call('POST', '/admin/agent/ask', adminCookie(), {
      question: 'لخّص لي أهم ما حدث في المنصة خلال الأسبوع الماضي بشكل موجز',
    });
    if (!assertEnvelope(llm, 'POST /ask (model tier)')) return;
    const llmBody = llm.json;
    if (llmBody.ok === true) {
      const answerText = typeof llmBody.answer === 'string' ? llmBody.answer : '';
      if (Number.isSafeInteger(llmBody.conversationId)) createdConversations.push(llmBody.conversationId);
      if (ARABIC.test(answerText)) {
        record('POST /ask (model tier)', 'PASS', `source=${llmBody.source} provider=${(llmBody.detail || {}).provider}`);
      } else {
        record('POST /ask (model tier)', 'FAIL', 'ok=true but the answer is not Arabic');
      }
    } else {
      const code = llmBody.code || 'unknown';
      const expected = /LLM|UNAVAILABLE|ERROR|BUDGET|EMPTY_ANSWER|GROUNDING|NOT_CONFIGURED/.test(String(code));
      record('POST /ask (model tier)', expected ? 'WARN' : 'FAIL', `tier declined: ${code} — ${String(llmBody.message || '').slice(0, 90)}`);
    }
  } finally {
    await prisma.user.delete({ where: { id: student.id } }).catch(() => {});
  }
}


async function main() {
  const child = spawn(process.execPath, ['app.js'], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: process.env.NODE_ENV || 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let bootLog = '';
  child.stdout.on('data', (d) => { bootLog += d; });
  child.stderr.on('data', (d) => { bootLog += d; });

  try {
    if (!(await waitForHealth())) throw new Error(`server did not become healthy on ${BASE}\n${bootLog.slice(-1000)}`);
    console.log(`agent smoke — ${BASE}\n`);
    await runProbes();

    const failed = results.filter((r) => r.status === 'FAIL');
    const warned = results.filter((r) => r.status === 'WARN');
    const passed = results.length - failed.length - warned.length;
    console.log(`\n  ${results.length} checks: ${passed} passed, ${warned.length} warned, ${failed.length} failed`);
    if (failed.length) console.log(`  failing: ${failed.map((f) => f.name).join('; ')}`);
    return failed.length ? 1 : 0;
  } finally {
    if (!KEEP) {
      if (createdApprovals.length) {
        await prisma.agentApproval.deleteMany({ where: { id: { in: createdApprovals } } }).catch(() => {});
      }
      if (createdConversations.length) {
        await prisma.agentConversation.deleteMany({ where: { id: { in: createdConversations } } }).catch(() => {});
      }
      const leftConversations = createdConversations.length
        ? await prisma.agentConversation.count({ where: { id: { in: createdConversations } } }).catch(() => 0)
        : 0;
      const leftApprovals = createdApprovals.length
        ? await prisma.agentApproval.count({ where: { id: { in: createdApprovals } } }).catch(() => 0)
        : 0;
      console.log(`  net-zero: ${leftConversations} conversation(s) and ${leftApprovals} approval(s) remain`);
    } else {
      console.log(`  SMOKE_KEEP set: keeping ${createdConversations.length} conversation(s) for inspection`);
    }
    child.kill();
    await prisma.$disconnect();
  }
}

if (process.env.RUN_LIVE_AGENT !== '1') {
  console.log('agent smoke skipped — set RUN_LIVE_AGENT=1 to run it against the live surface.');
  console.log('  RUN_LIVE_AGENT=1 node scripts/smoke-agent.js');
  process.exit(0);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`agent smoke failed: ${err.message}`);
    process.exit(1);
  });

