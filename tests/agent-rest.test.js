'use strict';
/* Agent REST surface (node:test, no deps): the admin-only boundary and the ask
 * contract. Runs against the server the repo runner spawns (TEST_BASE_URL), the
 * same way admin-guard.test.js does — including its auth pattern:
 *  - unauthenticated → 401, student → 403 on every /admin/agent surface;
 *  - a catalogued question is answered without any model call (no LLM spend);
 *  - owning vs foreign conversations stay separated.
 *
 * Net-zero: scratch conversations/approvals are deleted in after().
 *
 * Run: npm test
 */
process.chdir(__dirname + '/..');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createToken } = require('../src/utils.js');
const config = require('../src/config/env.js');
const { randomBase36Slug } = require('../src/utils/slugs.js');
const { PrismaClient } = require('@prisma/client');

const API = process.env.TEST_BASE_URL || 'http://localhost:3005';
const prisma = new PrismaClient();

const adminCookie = () =>
  `accessToken=${createToken({ id: 1, email: 'admin@elearning.com', name: 'T', role: 'ADMIN' }, config.jwt.secret)}`;

async function req(method, path, cookie, body) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-json */
  }
  return { status: res.status, json };
}

let student = null;
const createdConversations = [];
const createdApprovals = [];

describe('agent REST surface', () => {
  before(async () => {
    const email = `agentrest-${Date.now()}@localhost.test`;
    const user = await prisma.user.create({
      data: { slug: randomBase36Slug(), name: 'Agent Rest', email, password: 'x', grade: 'FIRST_SECONDARY' },
    });
    student = {
      user,
      cookie: `accessToken=${createToken({ id: user.id, email, name: 'A', role: 'STUDENT' }, config.jwt.secret)}`,
    };
  });

  after(async () => {
    await prisma.agentApproval.deleteMany({ where: { adminId: 1, toolName: { startsWith: 'agent_rest_probe_' } } });
    await prisma.agentConversation.deleteMany({ where: { id: { in: createdConversations } } });
    if (student) {
      await prisma.user.delete({ where: { id: student.user.id } });
      assert.equal(await prisma.user.count({ where: { id: student.user.id } }), 0, 'net-zero user');
    }
    await prisma.$disconnect();
  });

  it('rejects unauthenticated agents with 401 and students with 403', async () => {
    for (const [method, path, body] of [
      ['GET', '/admin/agent/conversations', null],
      ['GET', '/admin/agent/conversations/1/messages', null],
      ['POST', '/admin/agent/ask', { question: 'نظرة عامة على المنصة' }],
      ['POST', '/admin/agent/approvals/1/decide', { approved: true }],
      ['GET', '/admin/agent/approvals/1', null],
      ['POST', '/admin/agent/approvals', { toolName: 'agent_rest_probe_x', args: {} }],
    ]) {
      const anon = await req(method, path, null, body);
      assert.equal(anon.status, 401, `${method} ${path} unauthenticated must 401`);
      const denied = await req(method, path, student.cookie, body);
      assert.equal(denied.status, 403, `${method} ${path} student must 403`);
    }
  });

  it('answers a catalogued question through REST, deterministically', async () => {
    const res = await req('POST', '/admin/agent/ask', adminCookie(), { question: 'توزيع الطلاب على الصفوف' });
    assert.equal(res.status, 200, `ask failed: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.success, true);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.source, 'deterministic');
    assert.ok(typeof res.json.answer === 'string' && res.json.answer.startsWith('### '));
    assert.ok(Number.isSafeInteger(res.json.conversationId));
    createdConversations.push(res.json.conversationId);

    const history = await req('GET', `/admin/agent/conversations/${res.json.conversationId}/messages`, adminCookie());
    assert.equal(history.status, 200);
    assert.deepEqual(
      history.json.data.map((m) => m.role),
      ['USER', 'ASSISTANT']
    );
  });

  it('validates the ask body before any work happens', async () => {
    const missing = await req('POST', '/admin/agent/ask', adminCookie(), {});
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, 'AGENT_QUESTION_REQUIRED');

    const tooLong = await req('POST', '/admin/agent/ask', adminCookie(), { question: 'x'.repeat(2001) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.json.code, 'AGENT_QUESTION_TOO_LONG');

    const badIds = await req('POST', '/admin/agent/ask', adminCookie(), {
      question: 'نظرة عامة',
      conversationId: 'junk',
    });
    assert.equal(badIds.status, 400);
    assert.equal(badIds.json.code, 'AGENT_INVALID_INPUT');
  });

  it('keeps an admin’s conversations separated from another admin’s', async () => {
    const mine = await req('POST', '/admin/agent/ask', adminCookie(), { question: 'توزيع الطلاب على الصفوف' });
    assert.equal(mine.status, 200);
    createdConversations.push(mine.json.conversationId);

    // The scratch student can list conversations but will never see the admin's.
    const other = await req('GET', '/admin/agent/conversations', student.cookie);
    assert.equal(other.status, 403);

    // A malformed id is a 400, not a 500.
    const malformed = await req('GET', '/admin/agent/conversations/abc/messages', adminCookie());
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.code, 'AGENT_INVALID_INPUT');
  });

  /**
   * Phase 4.5 — the endpoint that shipped broken.
   *
   * `POST /admin/agent/approvals` had NO test at all, which is exactly why two
   * defects survived into the Phase 4 commit: `requestApproval` was never imported
   * (every call → ReferenceError → 500), and the optional `ttlMs` was never
   * defaulted (every call without it → 400). Both are invisible to a reader and to
   * every other suite, so this test now walks the whole create → read → decide path.
   */
  it('creates, reads and decides an approval request (this endpoint used to always fail)', async () => {
    const created = await req('POST', '/admin/agent/approvals', adminCookie(), {
      toolName: 'agent_rest_probe_reset_quiz_attempt',
      args: { userSlug: 'aaaaaaaaaaaa', quizSlug: 'bbbbbbbbbbbb' },
    });
    assert.equal(created.status, 201, `create failed: ${JSON.stringify(created.json)}`);
    assert.equal(created.json.success, true);
    assert.equal(created.json.data.status, 'PENDING');
    assert.equal(created.json.data.toolName, 'agent_rest_probe_reset_quiz_attempt');
    assert.ok(Number.isSafeInteger(created.json.data.id), 'an approval id must be returned');
    assert.ok(!Number.isNaN(Date.parse(created.json.data.expiresAt)), 'expiresAt is a timestamp');
    // The raw args must NOT be echoed back: the endpoint answers with a hash.
    assert.equal(created.json.data.args, undefined, 'args must not be echoed in the response');
    createdApprovals.push(created.json.data.id);

    const read = await req('GET', `/admin/agent/approvals/${created.json.data.id}`, adminCookie());
    assert.equal(read.status, 200);
    assert.equal(read.json.data.status, 'PENDING');
    assert.equal(read.json.data.argsHash, created.json.data.argsHash, 'the hash must be stable');

    const rejected = await req('POST', `/admin/agent/approvals/${created.json.data.id}/decide`, adminCookie(), {
      approved: false,
    });
    assert.equal(rejected.status, 200, `decide failed: ${JSON.stringify(rejected.json)}`);
    assert.equal(rejected.json.data.status, 'REJECTED');

    // A decided request cannot be decided again — the HITL flow is one-shot. The
    // route maps every non-(404) approval failure to 409, not 400: a second decision
    // is a state conflict, not a malformed request.
    const again = await req('POST', `/admin/agent/approvals/${created.json.data.id}/decide`, adminCookie(), {
      approved: true,
    });
    assert.equal(again.status, 409, 'a decided approval must not be re-decided');
    assert.match(again.json.code, /^AGENT_APPROVAL_/, 'the conflict must carry a specific code');
  });

  it('rejects an approval request with a bad tool name or an out-of-range ttl', async () => {
    const badName = await req('POST', '/admin/agent/approvals', adminCookie(), {
      toolName: 'Not A Tool Name',
      args: {},
    });
    assert.equal(badName.status, 400);
    assert.equal(badName.json.code, 'AGENT_APPROVAL_INVALID_INPUT');

    const badTtl = await req('POST', '/admin/agent/approvals', adminCookie(), {
      toolName: 'agent_rest_probe_x',
      args: {},
      ttlMs: 5,
    });
    assert.equal(badTtl.status, 400, 'a ttl below the floor must be refused, not silently clamped');
    assert.equal(badTtl.json.code, 'AGENT_APPROVAL_INVALID_INPUT');
  });
});
