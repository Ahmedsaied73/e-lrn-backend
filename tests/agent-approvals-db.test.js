'use strict';

/**
 * Phase 3 — the HITL approval gate (live DB, verifying a teammate's module).
 *
 * The interesting property is not "an approval can be approved" — it is that an
 * approval is bound to ONE tool and ONE argument set, is single-use, and expires.
 * Each of those is a test here, because a hole in any one of them turns the human
 * gate into decoration.
 */

process.env.REDIS_ENABLED = 'false';
process.env.DATABASE_CONNECTION_LIMIT = '5';

const test = require('node:test');
const assert = require('node:assert/strict');

const prisma = require('../src/config/db');
const {
  AgentApprovalError,
  canonicalArgsHash,
  requestApproval,
  decideApproval,
  consumeApproval,
  expireStaleApprovals,
  getApproval,
} = require('../src/services/agent/approvals');

const ADMIN_ID = 1;
const OTHER_ADMIN_ID = 999999; // deliberately not a real user: ownership is a field comparison
const TOOL = 'mark_enrollment_paid';
const ARGS = { userSlug: 'aaaaaaaaaaaa', courseSlug: 'bbbbbbbbbbbb' };
const TTL_MS = 60_000;

const created = [];

async function makeApproval(overrides = {}) {
  const approval = await requestApproval({
    prisma,
    adminId: ADMIN_ID,
    toolName: TOOL,
    args: ARGS,
    ttlMs: TTL_MS,
    ...overrides,
  });
  created.push(approval.id);
  return approval;
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof AgentApprovalError, `expected AgentApprovalError, got ${err.name}: ${err.message}`);
    assert.equal(err.code, code);
    return true;
  });
}

test('the argument hash binds to values, not to key order', () => {
  const a = canonicalArgsHash(TOOL, { userSlug: 'x', courseSlug: 'y' });
  const b = canonicalArgsHash(TOOL, { courseSlug: 'y', userSlug: 'x' });
  assert.equal(a, b, 'key order must not change the hash');
  assert.equal(a.length, 64);

  // A different tool, a different value, or a different array order is a different approval.
  assert.notEqual(a, canonicalArgsHash('unenroll_student', { userSlug: 'x', courseSlug: 'y' }));
  assert.notEqual(a, canonicalArgsHash(TOOL, { userSlug: 'x', courseSlug: 'z' }));
  assert.equal(canonicalArgsHash('t', { ids: [1, 2] }), canonicalArgsHash('t', { ids: [1, 2] }));
  assert.notEqual(canonicalArgsHash('t', { ids: [1, 2] }), canonicalArgsHash('t', { ids: [2, 1] }));
  // Nested objects are canonicalized too.
  assert.equal(canonicalArgsHash('t', { a: { b: 1, c: 2 } }), canonicalArgsHash('t', { a: { c: 2, b: 1 } }));
});

test('undefined keys do not change the hash, so the approval survives arg normalization', () => {
  const hash = canonicalArgsHash(TOOL, { userSlug: 'x', expiresInDays: undefined, courseSlug: 'y' });
  assert.equal(hash, canonicalArgsHash(TOOL, { userSlug: 'x', courseSlug: 'y' }));
});

test('a requested approval is pending and owned only by its requester', async () => {
  const approval = await makeApproval();
  assert.equal(approval.status, 'PENDING');
  assert.equal(approval.toolName, TOOL);

  const mine = await getApproval({ prisma, approvalId: approval.id, adminId: ADMIN_ID });
  assert.equal(mine.id, approval.id);
  assert.equal(mine.argsHash, approval.argsHash);
  assert.equal(mine.args, undefined, 'the raw args must never be returned');

  assert.equal(await getApproval({ prisma, approvalId: approval.id, adminId: OTHER_ADMIN_ID }), null);
  await expectCode(
    decideApproval({ prisma, approvalId: approval.id, adminId: OTHER_ADMIN_ID, approved: true }),
    'NOT_OWNED'
  );
});

test('an undecided approval cannot be consumed', async () => {
  const approval = await makeApproval();
  await expectCode(
    consumeApproval({ prisma, approvalId: approval.id, adminId: ADMIN_ID, toolName: TOOL, args: ARGS }),
    'NOT_PENDING'
  );
});

test('an approved approval can be consumed exactly once', async () => {
  const approval = await makeApproval();
  const decided = await decideApproval({ prisma, approvalId: approval.id, adminId: ADMIN_ID, approved: true });
  assert.equal(decided.status, 'APPROVED');
  assert.equal(decided.decidedBy, ADMIN_ID);

  const consumed = await consumeApproval({
    prisma,
    approvalId: approval.id,
    adminId: ADMIN_ID,
    toolName: TOOL,
    args: ARGS,
  });
  assert.equal(consumed.toolName, TOOL);

  const after = await getApproval({ prisma, approvalId: approval.id, adminId: ADMIN_ID });
  assert.equal(after.status, 'CONSUMED');
  assert.ok(after.consumedAt, 'consumedAt must be recorded');

  // The whole point: replaying the same approval must fail.
  await expectCode(
    consumeApproval({ prisma, approvalId: approval.id, adminId: ADMIN_ID, toolName: TOOL, args: ARGS }),
    'ALREADY_CONSUMED'
  );
});

test('an approval for one call cannot be spent on a different one', async () => {
  const approval = await makeApproval();
  await decideApproval({ prisma, approvalId: approval.id, adminId: ADMIN_ID, approved: true });

  // Different arguments: refused.
  await expectCode(
    consumeApproval({
      prisma,
      approvalId: approval.id,
      adminId: ADMIN_ID,
      toolName: TOOL,
      args: { userSlug: 'aaaaaaaaaaaa', courseSlug: 'cccccccccccc' },
    }),
    'ARGS_MISMATCH'
  );
  // Different tool: refused.
  await expectCode(
    consumeApproval({ prisma, approvalId: approval.id, adminId: ADMIN_ID, toolName: 'unenroll_student', args: ARGS }),
    'TOOL_MISMATCH'
  );

  const stillApproved = await getApproval({ prisma, approvalId: approval.id, adminId: ADMIN_ID });
  assert.equal(stillApproved.status, 'APPROVED', 'a failed consume must not burn the approval');

  // ...and the original call still works.
  await consumeApproval({ prisma, approvalId: approval.id, adminId: ADMIN_ID, toolName: TOOL, args: ARGS });
});

test('a rejection is final', async () => {
  const approval = await makeApproval();
  const decided = await decideApproval({ prisma, approvalId: approval.id, adminId: ADMIN_ID, approved: false });
  assert.equal(decided.status, 'REJECTED');
  await expectCode(
    consumeApproval({ prisma, approvalId: approval.id, adminId: ADMIN_ID, toolName: TOOL, args: ARGS }),
    'REJECTED'
  );
});

test('an expired approval is refused and marked expired', async () => {
  const approval = await makeApproval({ ttlMs: 30_000 });
  await decideApproval({ prisma, approvalId: approval.id, adminId: ADMIN_ID, approved: true });

  // Move the deadline into the past instead of waiting 30 seconds.
  await prisma.agentApproval.update({
    where: { id: approval.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });

  await expectCode(
    consumeApproval({ prisma, approvalId: approval.id, adminId: ADMIN_ID, toolName: TOOL, args: ARGS }),
    'EXPIRED'
  );
  const after = await getApproval({ prisma, approvalId: approval.id, adminId: ADMIN_ID });
  assert.equal(after.status, 'EXPIRED');
});

test('stale approvals can be swept, and the sweep is safe to repeat', async () => {
  const approval = await makeApproval();
  await prisma.agentApproval.update({
    where: { id: approval.id },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });

  const first = await expireStaleApprovals({ prisma });
  assert.ok(first.expired >= 1);

  const second = await expireStaleApprovals({ prisma });
  assert.equal(second.expired, 0, 'a sweep with nothing to do is a normal result, not an error');
});

test('approved-but-unconsumed approvals are swept too, so nothing lingers forever', async () => {
  const approval = await makeApproval();
  await decideApproval({ prisma, approvalId: approval.id, adminId: ADMIN_ID, approved: true });
  await prisma.agentApproval.update({
    where: { id: approval.id },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });

  await expireStaleApprovals({ prisma });
  const after = await getApproval({ prisma, approvalId: approval.id, adminId: ADMIN_ID });
  assert.equal(after.status, 'EXPIRED');
});

test('invalid input is rejected before any row is written', async () => {
  await expectCode(
    requestApproval({ prisma, adminId: ADMIN_ID, toolName: 'Bad Name', args: ARGS, ttlMs: TTL_MS }),
    'INVALID_INPUT'
  );
  await expectCode(requestApproval({ prisma, adminId: 0, toolName: TOOL, args: ARGS, ttlMs: TTL_MS }), 'INVALID_INPUT');
  await expectCode(requestApproval({ prisma, adminId: ADMIN_ID, toolName: TOOL, args: ARGS, ttlMs: 1000 }), 'INVALID_INPUT');
  await expectCode(
    consumeApproval({ prisma, approvalId: 999999999, adminId: ADMIN_ID, toolName: TOOL, args: ARGS }),
    'NOT_FOUND'
  );
});

test('cleanup', async () => {
  await prisma.agentApproval.deleteMany({ where: { id: { in: created } } });
  const leftovers = await prisma.agentApproval.count({ where: { id: { in: created } } });
  assert.equal(leftovers, 0, 'this suite must leave no approval rows behind');
  await prisma.$disconnect();
});

