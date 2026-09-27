'use strict';

/**
 * _kit.js — the ONE place every agent tool gets its cross-cutting behaviour, so
 * no individual tool can forget one:
 *
 *   CAPS   row-returning reads are clamped to config.aiAgent.maxToolResultRows
 *          (50 by default) no matter what the model asks for, AND every payload
 *          — read or action — is capped in CHARS by maxToolResultChars()
 *          (12,000 by default) in finalize(), the single funnel.
 *   CACHE  reads may declare cacheTtlSeconds and go through the repo's fail-open
 *          cache (src/integrations/redis/cache.js). Actions are NEVER cached.
 *   PII    every payload is passed through redactPayload() before it can reach a
 *          model (emails masked; names and phones allowed by product decision).
 *   META   every result carries { asOf, ms, cappedAt } so the answer can state
 *          its time window and admit truncation.
 *   HITL   action tools REFUSE to run unless the caller passes ctx.approved ===
 *          true — a second, independent guard behind the graph interrupt, so a
 *          mis-wired Phase 3 still cannot mutate anything by accident.
 *   AUDIT  actions write one AuditLog row (best-effort; auditing never fails the
 *          action).
 *
 * Definitions are PLAIN OBJECTS, not LangChain tools: Phase 1 stays free of any
 * LLM dependency, every tool is unit-testable, and index.js converts them with
 * toLangChainTools() only when the agent tier needs them.
 */

const { z } = require('zod');
const config = require('../../../config/env');
const cache = require('../../../integrations/redis/cache');
const audit = require('../../auditLog');
const { redactPayload } = require('../pii');

const KIND_READ = 'read';
const KIND_ACTION = 'action';

/** Typed tool failure (code is what the answer layer maps to Arabic text). */
class AgentToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentToolError';
    this.code = code;
  }
}

/** Hard cap for every row-returning read — config-clamped at boot. */
function maxRows() {
  return config.aiAgent.maxToolResultRows;
}

/** The model may ask for fewer rows than the cap, never more. */
function clampTake(requested, fallback = 25) {
  const n = Number(requested);
  const safe = Number.isSafeInteger(n) && n > 0 ? n : fallback;
  return Math.min(safe, maxRows());
}

/** The only date-range helpers tools use: bounded, explicit, timezone-free. */
function daysAgo(days, now = new Date()) {
  const d = Number(days);
  const safeDays = Number.isFinite(d) && d > 0 && d <= 3650 ? d : 30;
  return new Date(now.getTime() - safeDays * 24 * 60 * 60 * 1000);
}

/**
 * Read-only definition. `run(args, ctx)` must return a JSON-serializable object;
 * rows go under `rows` and set `truncated: true` when more rows existed.
 */
function readTool({ name, description, schema = z.object({}), cacheTtlSeconds = 30, run }) {
  return { kind: KIND_READ, name, description, schema, cacheTtlSeconds, requiresApproval: false, run };
}

/**
 * Mutating definition. `audit` is mandatory: an action that leaves no evidence
 * is not allowed to exist. `run` returns the payload plus `targetId` when the
 * audit row needs a concrete target.
 */
function actionTool({ name, description, schema = z.object({}), audit: auditSpec, run }) {
  if (!auditSpec || typeof auditSpec.action !== 'string') {
    throw new Error(`action tool "${name}" must declare an audit spec`);
  }
  return {
    kind: KIND_ACTION,
    name,
    description,
    schema,
    cacheTtlSeconds: 0,
    requiresApproval: true,
    audit: auditSpec,
    run,
  };
}

function cacheKeyFor(name, args) {
  return cache.buildKey('agent', name, cache.shortHash(JSON.stringify(args)));
}

/**
 * Argument names that must never be persisted in the audit trail.
 *
 * WHY THIS EXISTS: execute() records `metadata.args` for every action, and the
 * audit helper only sanitizes its TOP-LEVEL keys — so a nested `args.password`
 * sailed straight into `AuditLog.metadata` as plaintext. The catalogue has a tool
 * that legitimately takes a password (create_student mirrors the register path),
 * which is what turned a latent hole into a real one. Redaction happens HERE rather
 * than in each tool so no future tool can reintroduce it by forgetting.
 */
const SECRET_ARG_KEYS = new Set([
  'password',
  'newPassword',
  'currentPassword',
  'confirmPassword',
  'token',
  'accessToken',
  'refreshToken',
  'answerKey',
  'apiKey',
]);

function auditSafeArgs(args) {
  if (!args || typeof args !== 'object') return null;
  const safe = {};
  for (const [key, value] of Object.entries(args)) {
    safe[key] = SECRET_ARG_KEYS.has(key) ? '[redacted]' : value;
  }
  return safe;
}

/**
 * Hard cap on the SERIALIZED SIZE of one tool result, for every read AND every
 * action — config-clamped at boot. Additive to the row cap above: rows say how
 * many records ship, chars say how many BYTES they cost, and only the second is
 * what the model is re-billed for on every subsequent step of the turn.
 */
function maxToolResultChars() {
  return config.aiAgent.maxToolResultChars;
}

/** JSON char count of an already-JSON-safe value (payloads are redacted first). */
function charsOf(value) {
  const json = JSON.stringify(value);
  return typeof json === 'string' ? json.length : 0;
}

/**
 * Largest prefix of `list` that still serializes to <= budget chars, found by
 * bisection. One JSON.stringify per probe (~8 probes for a 200-row list) instead
 * of a linear walk that would re-serialize the whole tail 200 times.
 */
function longestFittingPrefix(list, budget, build) {
  if (charsOf(build(list.length)) <= budget) return list.length;
  let lo = 0;
  let hi = list.length - 1; // known-too-large
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (charsOf(build(mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Cut an over-budget payload down to `cap` chars and SAY SO, or return null when
 * it already fits (a small payload is returned untouched, so ordinary answers stay
 * byte-identical to what this layer produced before the cap existed).
 *
 * WHY the head of `rows`, and why scalars are never dropped:
 *   - rows are the bulk of every list-returning read, and they are the only part
 *     the model can re-obtain — it just calls the same tool again with a smaller
 *     `take` or a filter. Dropping a scalar instead (a `total`, a `returned`, an
 *     `asOf`) would destroy information that is NOT retrievable, and it would do
 *     so silently: the answer would look complete and be wrong. Admin tables are
 *     ordered newest-first, so the leading entries are the ones an answer cites.
 *   - Other array-valued keys are trimmed next (`items`, `courses`, …) in key
 *     order, for tools that list something other than `rows`.
 *   - The honesty fields are added to the payload itself (not only to meta) so
 *     that whatever renders the result — LLM tier, fast path, or the stored turn —
 *     cannot present a shortened list as a complete one.
 */
function trimPayloadToBudget(data, cap) {
  const fullChars = charsOf(data);
  if (fullChars <= cap) return null;

  const meta = {
    payloadTruncated: true,
    payloadChars: fullChars,
    payloadRows: Array.isArray(data)
      ? data.length
      : data && typeof data === 'object' && Array.isArray(data.rows)
        ? data.rows.length
        : null,
  };

  // A bare string has no list to shorten; slice it and keep the same shape.
  if (typeof data === 'string') {
    return { data: data.slice(0, Math.max(0, cap - 60)), meta };
  }

  if (Array.isArray(data)) {
    const keep = longestFittingPrefix(data, cap, (n) => data.slice(0, n));
    return { data: data.slice(0, keep), meta };
  }

  if (!data || typeof data !== 'object') return { data, meta };

  const working = { ...data };
  // The honesty fields cost characters too, so they are reserved BEFORE the
  // search — otherwise a payload trimmed to exactly the cap would ship over it
  // the moment `payloadChars` is attached.
  const emptyShape = {};
  for (const key of Object.keys(working)) {
    if (Array.isArray(working[key])) emptyShape[key] = [];
  }
  const budget = Math.max(0, cap - charsOf({ ...emptyShape, ...meta }));
  const fits = () => charsOf({ ...working, ...meta }) <= cap;

  const listKeys = Object.keys(working).filter((key) => Array.isArray(working[key]));
  // rows FIRST, then every other list in key order.
  const ordered = [...listKeys.filter((k) => k === 'rows'), ...listKeys.filter((k) => k !== 'rows')];
  for (const key of ordered) {
    if (fits()) break;
    const list = working[key];
    const keep = longestFittingPrefix(list, budget, (n) => ({ ...working, ...meta, [key]: list.slice(0, n) }));
    working[key] = list.slice(0, keep);
  }

  // Pathological case: the SCALARS alone exceed the cap. They are kept anyway —
  // a truncated-but-honest answer beats one with its own totals removed — and the
  // payloadTruncated flag is still set so the overshoot is never invisible.
  return { data: { ...working, ...meta }, meta };
}

function finalize(payload, def, startedAt) {
  // Cap AFTER redaction: the cap exists to bound what the MODEL pays for, and
  // redaction only ever shortens strings, so measuring before it would
  // under-count the real cost.
  const data = redactPayload(payload);
  const trimmed = trimPayloadToBudget(data, maxToolResultChars());
  return {
    data: trimmed ? trimmed.data : data,
    meta: {
      tool: def.name,
      asOf: new Date().toISOString(),
      ms: Date.now() - startedAt,
      cappedAt: def.kind === KIND_READ ? maxRows() : null,
    },
  };
}

/**
 * The safe runner. Tests call this directly; the LangChain wrapper (Phase 3)
 * calls it through toLangChainTools(). Order is deliberate:
 *   validate args → approval gate → cache (reads only) → run → audit → redact.
 *
 * The approval gate is a SECOND guard behind the graph interrupt: an action
 * definition refuses to execute unless the caller proves approval AND names the
 * admin who granted it. An unattributable mutation is not allowed to happen.
 */
async function execute(def, args, ctx = {}) {
  const prisma = ctx.prisma || require('../../../config/db');

  // STRICT parsing on purpose: Zod strips unknown keys by default, so a model
  // that invents an argument name would get a silently WIDER answer instead of
  // an error (e.g. a window it never actually applied). Failing loudly with the
  // offending key lets the model correct itself on the next step.
  const schema = typeof def.schema.strict === 'function' ? def.schema.strict() : def.schema;
  const parsed = schema.safeParse(args === undefined ? {} : args);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new AgentToolError('INVALID_ARGS', `${def.name} received invalid arguments — ${detail}`);
  }

  if (def.kind === KIND_ACTION) {
    if (ctx.approved !== true) {
      throw new AgentToolError('APPROVAL_REQUIRED', `${def.name} mutates data and requires human approval`);
    }
    if (!Number.isSafeInteger(ctx.adminId) || ctx.adminId <= 0) {
      throw new AgentToolError('APPROVAL_REQUIRED', `${def.name} approval must be attributable to an admin`);
    }
  }

  const startedAt = Date.now();
  const runCtx = {
    prisma,
    adminId: Number.isSafeInteger(ctx.adminId) ? ctx.adminId : null,
    conversationId: Number.isSafeInteger(ctx.conversationId) ? ctx.conversationId : null,
  };
  const run = () => def.run(parsed.data, runCtx);

  const payload =
    def.kind === KIND_READ && def.cacheTtlSeconds > 0
      ? await cache.withCache(cacheKeyFor(def.name, parsed.data), def.cacheTtlSeconds, run)
      : await run();

  if (def.kind === KIND_ACTION) {
    // Evidence first-class: an action that leaves no audit row is not allowed.
    // Best-effort by contract (audit.record never throws) — auditing must never
    // roll back a completed mutation.
    await audit.record(
      { user: { id: ctx.adminId } },
      {
        action: def.audit.action,
        targetType: def.audit.targetType || null,
        targetId: Number.isSafeInteger(payload && payload.targetId) ? payload.targetId : null,
        metadata: {
          via: 'agent',
          tool: def.name,
          args: auditSafeArgs(parsed.data),
          ms: Date.now() - startedAt,
          conversationId: runCtx.conversationId,
        },
      }
    );
  }

  return finalize(payload, def, startedAt);
}

module.exports = {
  KIND_READ,
  KIND_ACTION,
  AgentToolError,
  maxRows,
  maxToolResultChars,
  trimPayloadToBudget,
  clampTake,
  daysAgo,
  readTool,
  actionTool,
  cacheKeyFor,
  finalize,
  execute,
};
