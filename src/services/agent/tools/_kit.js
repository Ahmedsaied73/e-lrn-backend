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
 *   GATE   Phase 3 (v2 rebuild, Decision #1): a plain KIND_ACTION executes the
 *          moment the model calls it — no approval flag, no button. The only
 *          precondition left is ATTRIBUTABILITY: an unattributable mutation
 *          (no real ctx.adminId) is not allowed to happen. Destructive /
 *          high-blast-radius tools are KIND_CONFIRM instead: a call with no
 *          token runs the read-only preview() and returns a single-use
 *          confirmation token (an AgentApproval row); the real run happens only
 *          when that exact token comes back with byte-equivalent args. See
 *          confirmableActionTool() and executeConfirmable() below.
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
// approvals.js depends on nothing local (node:crypto only), so this import can
// never close a require cycle back into the registry.
const { canonicalArgsHash, requestApproval } = require('../approvals');

const KIND_READ = 'read';
const KIND_ACTION = 'action';
const KIND_CONFIRM = 'confirm';

// The confirm token is the AgentApproval row id as a decimal string. The handoff
// (§3.3 z.string().uuid() vs §3.6 "no column changes" vs "the new row's id")
// cannot all hold at once — the row id is an autoincrement Int — so the token
// shape follows the TABLE (handoff D1 default), and the security property comes
// from the adminId + status + expiry + argsHash check, never from token entropy.
const CONFIRM_TOKEN_FIELD = 'confirmationToken';
const CONFIRM_TOKEN_RE = /^\d{1,15}$/;

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
 * Coerce a server-set timestamp to a Date, or null when there is nothing usable.
 *
 * Built for ONE field (`ctx.turnStartedAt`): the tool context crosses the LangChain
 * serialization boundary, so the value arrives as an ISO string in production and as a
 * Date in direct calls. `null` means "no boundary was supplied", which the confirmation
 * gate treats as "cannot evaluate" rather than "the boundary is now".
 */
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
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
 *
 * Phase 3 (Decision #1): actions EXECUTE ON CALL — requiresApproval is false by
 * construction now that nothing anywhere asks for a human approval flag.
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
    requiresApproval: false,
    audit: auditSpec,
    run,
  };
}

/**
 * Two-step mutating definition (handoff 3.3): preview-then-confirm, enforced by
 * the SERVER rather than only by the prompt. The model-facing schema is the
 * caller's schema extended with an OPTIONAL `confirmationToken`:
 *
 *   no token   → execute() runs preview() (read-only), stores a PENDING
 *                AgentApproval row bound to the args hash, and returns the
 *                row id as the token — nothing mutates.
 *   token back → execute() verifies adminId / PENDING / unexpired / argsHash,
 *                consumes the row (CONSUMED) and only then runs run().
 *
 * `preview` is mandatory: a confirm tool whose preview someone must trust to
 * not read the database wrong is exactly the tool this gate exists to stop.
 */
function confirmableActionTool({ name, description, schema = z.object({}), audit: auditSpec, preview, run }) {
  if (!auditSpec || typeof auditSpec.action !== 'string') {
    throw new Error(`confirm tool "${name}" must declare an audit spec`);
  }
  if (typeof preview !== 'function') {
    throw new Error(`confirm tool "${name}" must declare a read-only preview`);
  }
  if (typeof schema.extend !== 'function') {
    throw new Error(`confirm tool "${name}" schema must be an extensible Zod object`);
  }
  const confirmSchema = schema.extend({
    [CONFIRM_TOKEN_FIELD]: z
      .string()
      .regex(CONFIRM_TOKEN_RE, 'confirmationToken must be the numeric id string returned by the preview call')
      .optional()
      .describe('معرّف المعاينة الذي رجعه استدعاء المعاينة الأول؛ اتركه غائباُ لطلب معاينة، وضعه للتنفيذ بعد تأكيد المشرف الصريح على نفس المعطيات'),
  });
  return {
    kind: KIND_CONFIRM,
    name,
    description,
    schema: confirmSchema,
    cacheTtlSeconds: 0,
    requiresApproval: false,
    audit: auditSpec,
    preview,
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
 * The safe runner. Tests call this directly; the LangChain wrapper calls it
 * through toLangChainTools(). Order is deliberate:
 *   validate args → authority gate → cache (reads only) → run → audit → redact.
 *
 * Phase 3 (Decision #1): the approval flag is GONE. A plain action executes on
 * call; what remains is ATTRIBUTABILITY — every mutation must name the one
 * admin it belongs to, or it does not happen. KIND_CONFIRM tools go through
 * executeConfirmable() instead: they mutate only on a verified preview token.
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

  // Authority cannot come from the model: mutations are only ever executed for
  // a server-resolved, attributable admin. This is the surviving half of the
  // old approval gate (the `approved` flag half is removed by Decision #1).
  if (def.kind === KIND_ACTION || def.kind === KIND_CONFIRM) {
    if (!Number.isSafeInteger(ctx.adminId) || ctx.adminId <= 0) {
      throw new AgentToolError('ADMIN_REQUIRED', `${def.name} must be attributable to an admin (ADMIN_REQUIRED)`);
    }
  }

  const startedAt = Date.now();
  const runCtx = {
    prisma,
    adminId: Number.isSafeInteger(ctx.adminId) ? ctx.adminId : null,
    conversationId: Number.isSafeInteger(ctx.conversationId) ? ctx.conversationId : null,
    // SERVER-SET turn boundary (Phase 3.1, handoff C1). The caller stamps it when the
    // turn begins; it can never come from tool arguments, so the model cannot move it.
    // An absent/unparseable value leaves it null, and the gate then skips the
    // same-turn check rather than inventing a boundary it does not have.
    turnStartedAt: toDate(ctx.turnStartedAt),
  };

  if (def.kind === KIND_CONFIRM) {
    return executeConfirmable(def, parsed.data, ctx, runCtx, startedAt);
  }

  const run = () => def.run(parsed.data, runCtx);

  const payload =
    def.kind === KIND_READ && def.cacheTtlSeconds > 0
      ? await cache.withCache(cacheKeyFor(def.name, parsed.data), def.cacheTtlSeconds, run)
      : await run();

  if (def.kind === KIND_ACTION) {
    // Evidence first-class: an action that leaves no audit row is not allowed.
    // Best-effort by contract (audit.record never throws) — auditing must never
    // roll back a completed mutation.
    await recordAudit(def, payload, parsed.data, runCtx, startedAt);
  }

  return finalize(payload, def, startedAt);
}

/**
 * The one audit writer for both mutating kinds. Same shape as the historical
 * action audit row (via/tool/args/ms/conversationId) plus optional extra
 * metadata.
 *
 * Stage-tagged rows get their own ACTION NAME (Phase 3.1). A preview and a refused
 * confirmation are evidence — but they are not deletions, and every audit reader
 * (the agent's own audit tools, admin reports) groups by `action` alone. Filing a
 * preview under USER_DELETE made "what did I delete this week?" count refusals, so the
 * stage is now part of the name instead of a field the readers must remember to filter.
 * The confirmed/executed row keeps the historical name, so existing reports are intact.
 */
const AUDIT_STAGE_SUFFIX = Object.freeze({ preview: '_PREVIEW', confirm_refused: '_REFUSED' });

async function recordAudit(def, payload, args, runCtx, startedAt, extraMeta = {}) {
  await audit.record(
    { user: { id: runCtx.adminId } },
    {
      action: `${def.audit.action}${AUDIT_STAGE_SUFFIX[extraMeta.stage] || ''}`,
      targetType: def.audit.targetType || null,
      targetId: Number.isSafeInteger(payload && payload.targetId) ? payload.targetId : null,
      metadata: {
        via: 'agent',
        tool: def.name,
        args: auditSafeArgs(args),
        ms: Date.now() - startedAt,
        conversationId: runCtx.conversationId,
        ...extraMeta,
      },
    }
  );
}

/**
 * The preview/confirm half of execute() (handoff 3.3).
 *
 * No token  → PREVIEW: run the read-only preview(), store the args hash as a
 *   PENDING AgentApproval row (AI_AGENT_CONFIRMATION_TTL_MINUTES window), and
 *   hand its id back as the token. A preview refusal (target missing, audience
 *   empty…) issues NO token — there is nothing to confirm.
 * Token     → VERIFY then spend: ownership, tool binding, PENDING, unexpired,
 *   and a fresh hash of the current mutation args must ALL match before the
 *   single-use CONSUMED flip. Any failure is a typed refusal payload — a stale
 *   token never silently re-previews and never mutates.
 */
async function executeConfirmable(def, data, ctx, runCtx, startedAt) {
  const mutationArgs = { ...data };
  const confirmationToken = mutationArgs[CONFIRM_TOKEN_FIELD];
  delete mutationArgs[CONFIRM_TOKEN_FIELD];

  if (confirmationToken === undefined) {
    const previewPayload = await def.preview(mutationArgs, runCtx);
    let result;
    if (!previewPayload || typeof previewPayload !== 'object' || previewPayload.ok === false) {
      // Nothing to confirm: the refusal IS the answer, and no row is pending.
      result = previewPayload || { ok: false, reason: 'PREVIEW_FAILED', detail: `${def.name} preview returned nothing.` };
    } else {
      const ttlMs = config.aiAgent.confirmationTtlMinutes * 60 * 1000;
      const row = await requestApproval({
        prisma: runCtx.prisma,
        adminId: runCtx.adminId,
        conversationId: runCtx.conversationId,
        toolName: def.name,
        args: mutationArgs,
        ttlMs,
      });
      result = {
        ok: true,
        stage: 'PREVIEW',
        confirmationRequired: true,
        [CONFIRM_TOKEN_FIELD]: String(row.id),
        confirmationExpiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
        preview: previewPayload,
        note:
          'معاينة فقط — لم تُنفَّذ أي عملية. اعرض المعاينة على المشرف واسأله تأكيدا ًصريحا ً، ولا تستدعِ الأداة مرة أخرى في نفس الدور. ' +
          'بعد التأكيد الصريح في رده التالي، استدعِ نفس الأداة بنفس المعطيات بالضبط مع confirmationToken. أي معطى متغيّر يبطل التوكن ويتطلب معاينة جديدة.',
      };
    }
    await recordAudit(def, result, mutationArgs, runCtx, startedAt, {
      stage: 'preview',
      [CONFIRM_TOKEN_FIELD]: result[CONFIRM_TOKEN_FIELD] ?? null,
    });
    return finalize(result, def, startedAt);
  }

  const refusal = await verifyConfirmationToken(def, mutationArgs, confirmationToken, runCtx);
  if (refusal) {
    await recordAudit(def, refusal, mutationArgs, runCtx, startedAt, {
      stage: 'confirm_refused',
      reason: refusal.reason,
    });
    return finalize(refusal, def, startedAt);
  }

  const payload = await def.run(mutationArgs, runCtx);
  await recordAudit(def, payload, mutationArgs, runCtx, startedAt, {
    stage: 'confirmed',
    [CONFIRM_TOKEN_FIELD]: Number(confirmationToken),
  });
  return finalize(payload, def, startedAt);
}

/**
 * The token gate. Order mirrors approvals.js: identify the row, prove
 * ownership, then the cheap state/expiry facts, then the TURN BOUNDARY and the
 * conversation binding, then the argument binding (hash), and only then spend it —
 * all failures return a typed reason, never a throw, so the model can explain the
 * refusal to the admin. A foreign row answers NOT_FOUND (no oracle, same doctrine
 * as getApproval).
 *
 * The order within the last two steps is the point: the same-turn check and the
 * conversation check both run BEFORE the hash comparison and BEFORE the consume, so a
 * same-turn probe cannot spend the token of a preview that a human was still reading.
 */
async function verifyConfirmationToken(def, mutationArgs, confirmationToken, runCtx) {
  const typed = (reason, detail) => ({ ok: false, reason, detail });

  if (typeof confirmationToken !== 'string' || !CONFIRM_TOKEN_RE.test(confirmationToken)) {
    return typed('CONFIRMATION_MISMATCH', 'confirmationToken must be the numeric id string a preview call returned.');
  }
  const approvalId = Number(confirmationToken);

  const row = await runCtx.prisma.agentApproval.findUnique({ where: { id: approvalId } });
  if (!row || row.adminId !== runCtx.adminId) {
    return typed('CONFIRMATION_NOT_FOUND', 'No confirmation matches this token.');
  }
  if (row.toolName !== def.name) {
    return typed('CONFIRMATION_MISMATCH', 'this confirmation token was issued for a different action.');
  }

  const now = new Date();
  const expiresMs = row.expiresAt instanceof Date ? row.expiresAt.getTime() : new Date(row.expiresAt).getTime();
  if (Number.isFinite(expiresMs) && expiresMs < now.getTime()) {
    try {
      // Best-effort bookkeeping — the refusal reason is already decided.
      await runCtx.prisma.agentApproval.updateMany({
        where: { id: approvalId, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
    } catch {
      /* ignored on purpose */
    }
    return typed('CONFIRMATION_EXPIRED', 'this confirmation is no longer valid — run a fresh preview.');
  }
  if (row.status === 'EXPIRED') {
    return typed('CONFIRMATION_EXPIRED', 'this confirmation is no longer valid — run a fresh preview.');
  }
  if (row.status !== 'PENDING') {
    // CONSUMED / APPROVED / REJECTED: the token no longer stands for an open
    // confirmation in the chat flow.
    return typed('CONFIRMATION_MISMATCH', `this confirmation token is already ${String(row.status).toLowerCase()}.`);
  }

  // Phase 3.1 / handoff C1 — THE TURN BOUNDARY. A confirmation made inside the very turn
  // that previewed it is not a confirmation: the model would be approving its own
  // request, so any student-authored text that reached its context (an essay, a
  // notification body carrying an injected instruction) could delete or broadcast
  // without a human ever answering. `turnStartedAt` is set by the server, never by tool
  // arguments. A row whose requestedAt cannot be read is refused too: the column is NOT
  // NULL in the model, so a missing stamp means the row cannot be proven older than the
  // turn — and unproven means refused, not allowed.
  if (runCtx.turnStartedAt) {
    const requestedAt = toDate(row.requestedAt);
    if (!requestedAt || requestedAt.getTime() >= runCtx.turnStartedAt.getTime()) {
      return typed(
        'CONFIRMATION_SAME_TURN',
        'this confirmation was previewed during the current turn — اعرض المعاينة على المشرف وانتظر رده التالي بتأكيد صريح.'
      );
    }
  }

  if (runCtx.conversationId !== null && row.conversationId !== runCtx.conversationId) {
    // A token belongs to the conversation that issued it: another thread is a different
    // conversation with the admin, and has confirmed nothing.
    return typed('CONFIRMATION_MISMATCH', 'this confirmation token was issued in another conversation.');
  }

  if (row.argsHash !== canonicalArgsHash(def.name, mutationArgs)) {
    return typed(
      'CONFIRMATION_MISMATCH',
      'the arguments changed since the preview — the token only authorises the exact data that was previewed. Run a fresh preview.'
    );
  }

  // Conditional consume: exactly one caller can flip PENDING, so a token cannot
  // be spent twice even by two concurrent confirmations.
  const claimed = await runCtx.prisma.agentApproval.updateMany({
    where: { id: approvalId, status: 'PENDING' },
    data: { status: 'CONSUMED', consumedAt: now, decidedAt: now, decidedBy: runCtx.adminId },
  });
  if (!claimed || claimed.count === 0) {
    return typed('CONFIRMATION_MISMATCH', 'this confirmation token was already used — run a fresh preview.');
  }
  return null;
}

module.exports = {
  KIND_READ,
  KIND_ACTION,
  KIND_CONFIRM,
  AgentToolError,
  maxRows,
  maxToolResultChars,
  trimPayloadToBudget,
  clampTake,
  daysAgo,
  readTool,
  actionTool,
  confirmableActionTool,
  cacheKeyFor,
  finalize,
  execute,
};
