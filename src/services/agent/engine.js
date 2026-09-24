'use strict';

/**
 * engine.js — the deterministic fast path (Phase 2).
 *
 * One call: an Arabic question in, an Arabic answer out — or an explicit "not
 * mine" handoff to the agentic tier. This is the ONLY Phase 2 module that touches
 * the database, and it touches it exclusively through the Phase 1 tool layer, so
 * every fast-path answer inherits row caps, fail-open caching, PII redaction and
 * timestamp metadata for free.
 *
 * Structural guarantees:
 *  - READ ONLY. The engine refuses any definition whose kind is not 'read', so
 *    even a catalogue edited to point at an action could not mutate anything
 *    from this tier. Fast answers are never writes.
 *  - Args are validated against the tool's STRICT Zod schema BEFORE the tool
 *    runs: router/tool drift becomes an explicit ROUTER_ARG_MISMATCH that is
 *    handed to the LLM, never a silently different answer.
 *  - A tool failure (DB down, timeout) is returned as a typed failure. It is
 *    never rendered as "no data" — those are different facts.
 *  - Disabled feature = disabled engine: with AI_AGENT_ENABLED=false the fast
 *    path answers nothing (fail closed), independent of any caller.
 */

const config = require('../../config/env');
const { readDefinitions, getDefinition } = require('./tools');
const { KIND_READ, execute } = require('./tools/_kit');
const { route, INTENTS } = require('./router');
const { renderAnswer, TEMPLATE_IDS } = require('./templates');

/**
 * Boot-time wiring check: every intent must name a real READ tool and a real
 * renderer. A bad catalogue edit then fails the deploy instead of the admin's
 * question — the same reason tools/index.js validates at load.
 */
function validateCatalogue() {
  const reads = new Set(readDefinitions.map((d) => d.name));
  const problems = [];
  for (const intent of INTENTS) {
    if (!reads.has(intent.tool)) {
      problems.push(`intent "${intent.id}" points at unknown or non-read tool "${intent.tool}"`);
    }
    if (!TEMPLATE_IDS.includes(intent.template)) {
      problems.push(`intent "${intent.id}" points at unknown template "${intent.template}"`);
    }
  }
  if (problems.length) throw new Error(`[agent/engine] catalogue is invalid: ${problems.join('; ')}`);
}

validateCatalogue();

/** True when the agent feature (and therefore this engine) is switched on. */
function isEnabled() {
  return Boolean(config.aiAgent && config.aiAgent.enabled);
}

/**
 * Answer a question deterministically, or decline.
 *
 * On success: { matched: true, answer, intent, tool, template, args, result, meta, latencyMs }
 * On decline: { matched: false, reason, candidates } where reason is one of
 *   AGENT_DISABLED | EMPTY | NO_INTENT | AMBIGUOUS | MISSING_SLOT_SLUG |
 *   UNKNOWN_TOOL | NOT_READ_ONLY | ROUTER_ARG_MISMATCH | TOOL_ERROR
 * A decline is a routing decision for the caller (Phase 3 answers it with the
 * LLM), not an exception.
 */
async function answerDeterministic(question, ctx = {}) {
  const startedAt = Date.now();

  if (!isEnabled()) return { matched: false, reason: 'AGENT_DISABLED', candidates: [] };

  const decision = route(question);
  if (!decision.matched) {
    return { matched: false, reason: decision.reason, candidates: decision.candidates };
  }

  const def = getDefinition(decision.tool);
  if (!def) return { matched: false, reason: 'UNKNOWN_TOOL', candidates: [decision.id] };
  if (def.kind !== KIND_READ) return { matched: false, reason: 'NOT_READ_ONLY', candidates: [decision.id] };

  const schema = typeof def.schema.strict === 'function' ? def.schema.strict() : def.schema;
  const parsed = schema.safeParse(decision.args);
  if (!parsed.success) {
    return {
      matched: false,
      reason: 'ROUTER_ARG_MISMATCH',
      candidates: [decision.id],
      detail: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
    };
  }

  let payload;
  try {
    payload = await execute(def, parsed.data, {
      prisma: ctx.prisma,
      adminId: ctx.adminId,
      conversationId: ctx.conversationId,
    });
  } catch (err) {
    return {
      matched: false,
      reason: 'TOOL_ERROR',
      candidates: [decision.id],
      error: { code: err.code || err.name, message: err.message },
    };
  }

  return {
    matched: true,
    source: 'deterministic',
    intent: decision.id,
    tool: def.name,
    template: decision.template,
    args: parsed.data,
    result: payload.data,
    meta: payload.meta,
    answer: renderAnswer(decision.template, payload.data, payload.meta),
    latencyMs: Date.now() - startedAt,
  };
}

module.exports = {
  answerDeterministic,
  isEnabled,
  validateCatalogue,
};
