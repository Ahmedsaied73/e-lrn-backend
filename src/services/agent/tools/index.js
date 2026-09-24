'use strict';

/**
 * tools/index.js — the agent tool registry (Phase 1).
 *
 * Why a registry of plain definitions instead of exporting LangChain tools:
 *  - Phase 1 must not depend on any LLM SDK. The repo lazy-requires LangChain
 *    everywhere (see src/services/aiGrader/provider.js) and this keeps that
 *    property: the SDK is only touched inside toLangChainTools().
 *  - Definitions carry metadata the graph needs and LangChain objects hide:
 *    kind (read/action), requiresApproval, audit spec, cache TTL.
 *  - Validation runs at LOAD time. A duplicate name, a missing Arabic
 *    description, or a mutation without an audit spec throws here — at boot —
 *    instead of surfacing as a wrong number in front of an admin.
 */

const config = require('../../../config/env');
const { KIND_READ, KIND_ACTION, execute } = require('./_kit');

const readDefinitions = [
  ...require('./platform'),
  ...require('./students'),
  ...require('./courses'),
  ...require('./quizzes'),
  ...require('./enrollments'),
  ...require('./operations'),
];

// Action definitions are LOADED but only exposed when the mutation switch is on
// (config.aiAgent.allowMutations, default false — see resolveAiAgent). The
// approval gate inside execute() is a second, independent guard.
const actionDefinitions = [...require('./actions')];

const NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;
const ARABIC_RE = /[\u0600-\u06FF]/;

function validate(defs, seen) {
  for (const def of defs) {
    const where = `tool "${def && def.name}"`;
    if (!def || typeof def !== 'object') throw new Error('[agent/tools] definition is not an object');
    if (!NAME_RE.test(def.name || '')) throw new Error(`[agent/tools] ${where}: name must be snake_case (a-z0-9_)`);
    if (seen.has(def.name)) throw new Error(`[agent/tools] duplicate tool name "${def.name}"`);
    seen.add(def.name);

    if (typeof def.description !== 'string' || def.description.trim().length < 20) {
      throw new Error(`[agent/tools] ${where}: description is required and must be explanatory`);
    }
    // Arabic-only doctrine, enforced mechanically rather than by convention.
    if (!ARABIC_RE.test(def.description)) throw new Error(`[agent/tools] ${where}: description must be in Arabic`);
    if (!def.schema || typeof def.schema.safeParse !== 'function') {
      throw new Error(`[agent/tools] ${where}: schema must be a Zod object`);
    }
    if (typeof def.run !== 'function') throw new Error(`[agent/tools] ${where}: run must be a function`);

    if (def.kind === KIND_ACTION) {
      if (def.requiresApproval !== true) throw new Error(`[agent/tools] ${where}: actions require approval`);
      if (!def.audit || typeof def.audit.action !== 'string') {
        throw new Error(`[agent/tools] ${where}: actions must declare an audit action`);
      }
      if (def.cacheTtlSeconds !== 0) throw new Error(`[agent/tools] ${where}: actions must never be cached`);
    } else if (def.kind === KIND_READ) {
      if (!Number.isSafeInteger(def.cacheTtlSeconds) || def.cacheTtlSeconds < 0) {
        throw new Error(`[agent/tools] ${where}: cacheTtlSeconds must be a non-negative integer`);
      }
    } else {
      throw new Error(`[agent/tools] ${where}: unknown kind "${def.kind}"`);
    }
  }
}

const seenNames = new Set();
validate(readDefinitions, seenNames);
validate(actionDefinitions, seenNames);

/** Tools visible to the model: read-only unless mutations are explicitly armed. */
function listDefinitions({ includeActions = Boolean(config.aiAgent.allowMutations) } = {}) {
  return includeActions ? [...readDefinitions, ...actionDefinitions] : [...readDefinitions];
}

function getDefinition(name) {
  return readDefinitions.find((d) => d.name === name) || actionDefinitions.find((d) => d.name === name) || null;
}

/**
 * Convert definitions to LangChain tools. `resolveContext(args)` supplies the
 * per-invocation context (at minimum { approved, adminId } for actions) — the
 * graph passes the approval it just received, which is exactly why the approval
 * gate cannot be bypassed by the model: it is not part of the tool's arguments.
 */
function toLangChainTools(defs = listDefinitions(), resolveContext = () => ({})) {
  const { tool } = require('@langchain/core/tools');
  return defs.map((def) =>
    tool(async (args) => execute(def, args, resolveContext(args)), {
      name: def.name,
      description: def.description,
      schema: def.schema,
    })
  );
}

module.exports = {
  readDefinitions,
  actionDefinitions,
  listDefinitions,
  getDefinition,
  toLangChainTools,
  toolNames: () => listDefinitions({ includeActions: true }).map((d) => d.name),
};
