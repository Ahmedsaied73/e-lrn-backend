'use strict';

/**
 * approvals.js — the single-use, argument-bound human approval ledger for the
 * mutating agent tools (Phase 3).
 *
 * WHY: the agent must be able to prove *what* was approved, not merely that somebody
 * approved something. One row binds a grant to one exact tool name and one exact
 * argument set (sha256 over a canonical serialization), makes the grant single-use,
 * and gives it a short TTL — so a confirmation for "send this to 3 students" can
 * never be replayed for a different call, by a different admin, or a second time.
 *
 * TWO CONSUMERS, one ledger:
 *  - the chat confirm flow (tools/_kit.js KIND_CONFIRM) records a preview as a
 *    PENDING row and spends that row as the confirmation token, and
 *  - the legacy REST/socket decision flow (decideApproval → consumeApproval) still
 *    works for a queued decision, without granting anything by itself.
 *
 * Contract:
 *  - The prisma client is always INJECTED (`{ prisma }`), never required here, so
 *    the ledger is unit-testable with a stub and opens no connection on import.
 *  - Every failure is an AgentApprovalError with a stable `code`; callers map
 *    codes to text instead of parsing messages.
 *  - `requestedAt` is the NODE clock, not the DB default: the confirmation gate
 *    compares it against a server-set turn timestamp, and a second clock on the
 *    other side of the pooler would make that comparison meaningless.
 *  - consumeApproval() is the gate for a DECIDED row: it re-derives the hash itself
 *    and flips APPROVED -> CONSUMED with a conditional updateMany, so two concurrent
 *    consumers can never both win, and a PENDING row (a request) can never be
 *    spent before a human decided it.
 *  - Nothing here logs, and getApproval() never returns the raw args payload
 *    (it may carry PII-adjacent values) — only its hash.
 */

const { createHash } = require('node:crypto');

const STATUS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  CONSUMED: 'CONSUMED',
});

const MIN_TTL_MS = 30 * 1000;
const MAX_TTL_MS = 30 * 60 * 1000;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

/** Typed approval failure — `code` is the stable part, the message is for logs-less debugging. */
class AgentApprovalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentApprovalError';
    this.code = code;
  }
}

function fail(code, message) {
  return new AgentApprovalError(code, message);
}

function assertPositiveInt(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw fail('INVALID_INPUT', `${field} must be a positive safe integer`);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The model delegate is injected with the client; requiring it here means a
 * mis-wired call fails as INVALID_INPUT instead of a TypeError deep inside Prisma.
 */
function modelOf(prisma) {
  if (!prisma || typeof prisma !== 'object' || !prisma.agentApproval) {
    throw fail('INVALID_INPUT', 'prisma must be injected as { prisma } and expose agentApproval');
  }
  return prisma.agentApproval;
}

/**
 * Canonical JSON: object keys sorted recursively, array order preserved, no
 * whitespace. It mirrors JSON.stringify on the awkward cases a caller would call
 * "the same call" (object values that are undefined are dropped, undefined array
 * slots become null, -0 becomes 0), and it REFUSES values JSON cannot represent
 * deterministically (NaN, Infinity, BigInt, function, symbol, class instance)
 * rather than collapsing them all to null and making distinct calls collide.
 */
function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);
  if (type === 'number') {
    if (!Number.isFinite(value)) throw fail('INVALID_INPUT', 'args contain a non-finite number');
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw fail('INVALID_INPUT', 'args contain an invalid Date');
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    // Indexed loop, not map(): map() skips holes, which would emit invalid JSON.
    const parts = [];
    for (let i = 0; i < value.length; i += 1) parts.push(canonicalJson(value[i]));
    return `[${parts.join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    const body = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',');
    return `{${body}}`;
  }
  throw fail('INVALID_INPUT', `args contain an unsupported ${type} value`);
}

/**
 * sha256 hex over `<toolName>\n<canonical json of args>`.
 * '\n' is a safe domain separator: tool names cannot contain it (TOOL_NAME_PATTERN)
 * and canonicalJson never emits a raw newline (strings are JSON-escaped), so the
 * tool name can never be confused with the start of the argument payload.
 */
function canonicalArgsHash(toolName, args) {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    throw fail('INVALID_INPUT', 'toolName must be a non-empty string');
  }
  if (!isPlainObject(args)) throw fail('INVALID_INPUT', 'args must be a plain object');
  return createHash('sha256').update(`${toolName}\n${canonicalJson(args)}`, 'utf8').digest('hex');
}

function expiresAtMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') return new Date(value).getTime();
  return NaN;
}

/**
 * Expiry is evaluated with a strict `<` so it agrees with expireStaleApprovals
 * (`expiresAt < now`): a row is valid until the instant it becomes unreachable. A
 * row whose expiresAt cannot be parsed is treated as NOT expired — the column is
 * NOT NULL in the model, so only a hand-written stub row can lack it.
 */
function isExpired(expiresAt, now) {
  const ms = expiresAtMs(expiresAt);
  if (!Number.isFinite(ms)) return false;
  return ms < now.getTime();
}

/** Maps a row's current status to the code that explains why it cannot be used. */
function statusError(status, approvalId) {
  const label = `approval ${approvalId}`;
  if (status === STATUS.REJECTED) return fail('REJECTED', `${label} was rejected`);
  if (status === STATUS.EXPIRED) return fail('EXPIRED', `${label} has expired`);
  if (status === STATUS.CONSUMED) return fail('ALREADY_CONSUMED', `${label} was already consumed`);
  return fail('NOT_PENDING', `${label} is not pending`);
}

/**
 * Best-effort housekeeping: callers are about to fail with EXPIRED anyway, so a
 * bookkeeping write must never replace the real reason with a database error.
 * Scoped to the status we just read so it cannot clobber a concurrent decision.
 */
async function markExpired(model, approvalId, status) {
  try {
    await model.updateMany({ where: { id: approvalId, status }, data: { status: STATUS.EXPIRED } });
  } catch {
    /* ignored on purpose */
  }
}

/** Re-read after a lost race, tolerating a stub/DB failure (the caller still fails closed). */
async function safeFind(model, approvalId) {
  try {
    return await model.findUnique({ where: { id: approvalId } });
  } catch {
    return null;
  }
}

/**
 * Create a PENDING request a human can decide. The raw args are stored for display
 * in the approval UI; the hash is what later binds the grant to this exact call.
 */
async function requestApproval({ prisma, adminId, conversationId = null, toolName, args, ttlMs } = {}) {
  assertPositiveInt(adminId, 'adminId');
  if (conversationId !== null) assertPositiveInt(conversationId, 'conversationId');
  if (typeof toolName !== 'string' || !TOOL_NAME_PATTERN.test(toolName)) {
    throw fail('INVALID_INPUT', `toolName must match ${TOOL_NAME_PATTERN}`);
  }
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    throw fail('INVALID_INPUT', `ttlMs must be an integer between ${MIN_TTL_MS} and ${MAX_TTL_MS}`);
  }
  const argsHash = canonicalArgsHash(toolName, args);
  const model = modelOf(prisma);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  // `requestedAt` is written from THIS clock on purpose. It is not decoration: the
  // confirmation gate refuses a token whose preview was requested inside the current
  // turn, and that comparison is only meaningful if both timestamps come from Node.
  // Left to the column's `@default(now())` it would be the database's clock, which is
  // a different, separately-synchronised clock on the other side of the pooler.
  const row = await model.create({
    data: { conversationId, adminId, toolName, argsHash, args, status: STATUS.PENDING, expiresAt, requestedAt: now },
  });

  return {
    id: row.id,
    toolName: row.toolName || toolName,
    argsHash: row.argsHash || argsHash,
    status: row.status || STATUS.PENDING,
    expiresAt: row.expiresAt || expiresAt,
    requestedAt: row.requestedAt || now,
  };
}

/** Decide a pending request. Only the owning admin may decide, and only once. */
async function decideApproval({ prisma, approvalId, adminId, approved } = {}) {
  assertPositiveInt(approvalId, 'approvalId');
  assertPositiveInt(adminId, 'adminId');
  if (typeof approved !== 'boolean') throw fail('INVALID_INPUT', 'approved must be a boolean');
  const model = modelOf(prisma);

  const row = await model.findUnique({ where: { id: approvalId } });
  if (!row) throw fail('NOT_FOUND', `approval ${approvalId} does not exist`);
  if (row.adminId !== adminId) throw fail('NOT_OWNED', `approval ${approvalId} belongs to another admin`);
  if (row.status !== STATUS.PENDING) throw statusError(row.status, approvalId);

  const now = new Date();
  if (isExpired(row.expiresAt, now)) {
    await markExpired(model, approvalId, STATUS.PENDING);
    throw fail('EXPIRED', `approval ${approvalId} has expired`);
  }

  const status = approved ? STATUS.APPROVED : STATUS.REJECTED;
  const applied = await model.updateMany({
    where: { id: approvalId, status: STATUS.PENDING },
    data: { status, decidedAt: now, decidedBy: adminId },
  });

  // Losing this race means somebody decided or expired the row between our read
  // and our write: report the row's actual state instead of claiming success.
  if (!applied || applied.count === 0) {
    const fresh = await safeFind(model, approvalId);
    throw statusError(fresh && fresh.status, approvalId);
  }

  return { id: approvalId, status, decidedAt: now, decidedBy: adminId };
}

/**
 * THE GATE. Order is deliberate: identify the row, prove ownership, then cheap
 * state/expiry facts, then the binding (tool + args hash), and only then spend it.
 */
async function consumeApproval({ prisma, approvalId, adminId, toolName, args } = {}) {
  assertPositiveInt(approvalId, 'approvalId');
  assertPositiveInt(adminId, 'adminId');
  if (typeof toolName !== 'string' || toolName.length === 0) {
    throw fail('INVALID_INPUT', 'toolName must be a non-empty string');
  }
  const argsHash = canonicalArgsHash(toolName, args);
  const model = modelOf(prisma);

  const row = await model.findUnique({ where: { id: approvalId } });
  if (!row) throw fail('NOT_FOUND', `approval ${approvalId} does not exist`);
  if (row.adminId !== adminId) throw fail('NOT_OWNED', `approval ${approvalId} belongs to another admin`);

  if (row.status !== STATUS.PENDING && row.status !== STATUS.APPROVED) {
    throw statusError(row.status, approvalId);
  }

  const now = new Date();
  if (isExpired(row.expiresAt, now)) {
    await markExpired(model, approvalId, row.status);
    throw fail('EXPIRED', `approval ${approvalId} has expired`);
  }

  // PENDING is a REQUEST, not a permission: it passes the state gate above only so
  // that expiry gets the chance to explain itself first, then it is refused here.
  if (row.status === STATUS.PENDING) {
    throw fail('NOT_PENDING', `approval ${approvalId} has not been approved yet`);
  }

  if (row.toolName !== toolName) {
    throw fail('TOOL_MISMATCH', `approval ${approvalId} was granted for a different tool`);
  }
  if (row.argsHash !== argsHash) {
    throw fail('ARGS_MISMATCH', `approval ${approvalId} was granted for different arguments`);
  }

  // Conditional consume: exactly one concurrent caller can flip APPROVED, so a
  // double-spent approval is impossible even without a transaction.
  const claimed = await model.updateMany({
    where: { id: approvalId, status: STATUS.APPROVED },
    data: { status: STATUS.CONSUMED, consumedAt: now },
  });
  if (!claimed || claimed.count === 0) {
    throw fail('ALREADY_CONSUMED', `approval ${approvalId} was already consumed`);
  }

  return { id: approvalId, toolName };
}

/** Housekeeping sweep: stale PENDING/APPROVED rows become EXPIRED. 0 is a normal result. */
async function expireStaleApprovals({ prisma, now = new Date() } = {}) {
  const model = modelOf(prisma);
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) throw fail('INVALID_INPUT', 'now must be a Date or a date-like value');

  const result = await model.updateMany({
    where: { status: { in: [STATUS.PENDING, STATUS.APPROVED] }, expiresAt: { lt: at } },
    data: { status: STATUS.EXPIRED },
  });
  return { expired: result && Number.isFinite(result.count) ? result.count : 0 };
}

/** Owner-only view for the approval UI. Missing and foreign are both null (no oracle). */
async function getApproval({ prisma, approvalId, adminId } = {}) {
  assertPositiveInt(approvalId, 'approvalId');
  assertPositiveInt(adminId, 'adminId');
  const model = modelOf(prisma);

  const row = await model.findUnique({ where: { id: approvalId } });
  if (!row) return null;
  if (row.adminId !== adminId) return null;

  // Deliberately no `args`: it may carry PII-adjacent values; the hash proves binding.
  return {
    id: row.id,
    toolName: row.toolName,
    argsHash: row.argsHash,
    status: row.status,
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt == null ? null : row.decidedAt,
    consumedAt: row.consumedAt == null ? null : row.consumedAt,
    conversationId: row.conversationId == null ? null : row.conversationId,
  };
}

module.exports = {
  AgentApprovalError,
  canonicalArgsHash,
  requestApproval,
  decideApproval,
  consumeApproval,
  expireStaleApprovals,
  getApproval,
};

