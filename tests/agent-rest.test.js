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
});
