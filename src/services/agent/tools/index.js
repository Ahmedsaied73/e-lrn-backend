'use strict';

/**
 * tools/index.js — the agent tool registry (Phase 1).
 *
 * Why a registry of plain definitions instead of exporting LangChain tools:
 *  - Phase 1 must not depend on any LLM SDK. The repo lazy-requires LangChain
 *    everywhere (see src/services/aiGrader/provider.js) and this keeps that
 *    property: the SDK is only touched inside toLangChainTools().
 *  - Definitions carry metadata the graph needs and LangChain objects hide:
 *    kind (read/action/confirm), audit spec, cache TTL, preview function.
 *  - Validation runs at LOAD time. A duplicate name, a missing Arabic
 *    description, or a mutation without an audit spec throws here — at boot —
 *    instead of surfacing as a wrong number in front of an admin.
 */

const config = require('../../../config/env');
const { KIND_READ, KIND_ACTION, KIND_CONFIRM, execute } = require('./_kit');

// Phase 1 (v2 rebuild): the router import went with the shortlist it fed. Nothing in
// this file derives the tool surface from INTENTS/route() any more -- see the surface
// note above approximateSchemaTokens().
const { wrapReadDefinition } = require('../toolCache');

// z is needed for toJSONSchema in stripUnsupportedSchemaKeys(). The tool files
// own their own schemas; this is only the serialiser the provider is shown.
const { z } = require('zod');

const readDefinitions = [
  ...require('./platform'),
  ...require('./students'),
  ...require('./courses'),
  ...require('./quizzes'),
  ...require('./enrollments'),
  ...require('./operations'),
  // Cross-conversation memory reads (Phase 7, §3.9): `list_memories` is visible on
  // every turn because recall must not depend on the mutation switch — an unarmed
  // agent can still USE what it learned, it just cannot WRITE (Decision #12's
  // cache/current-question doctrine extends naturally: reading is knowing).
  ...require('./memory').filter((def) => def.kind === KIND_READ),
  // Schema/metadata reads. Last in the list on purpose: they answer a question no
  // other tool can ("which TABLES does this platform have?"), so nothing that
  // already worked depends on them, and their 3 schemas are only bound when the
  // question is about the database.
  ...require('./schema'),
];

// Action definitions are LOADED but only exposed when the mutation switch is on
// (config.aiAgent.allowMutations, default false — see resolveAiAgent). Since the
// Phase 3 rebuild the second guard is different per kind: plain actions must be
// attributable to the admin, and confirm tools cannot mutate without a token
// their own preview issued (both enforced inside execute()).
const actionDefinitions = [...require('./actions'), ...require('./memory').filter((def) => def.kind !== KIND_READ)];

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
      // Phase 3 (Decision #1): actions execute on call. Asserting requiresApproval
      // is FALSE is the structural pin — a tool claiming a human approval gate
      // could only mean the removed flag is sneaking back in.
      if (def.requiresApproval !== false) throw new Error(`[agent/tools] ${where}: actions execute immediately — requiresApproval must be false`);
      if (!def.audit || typeof def.audit.action !== 'string') {
        throw new Error(`[agent/tools] ${where}: actions must declare an audit action`);
      }
      if (def.cacheTtlSeconds !== 0) throw new Error(`[agent/tools] ${where}: actions must never be cached`);
    } else if (def.kind === KIND_CONFIRM) {
      // Two-step tools (handoff 3.3): the preview is as mandatory as the audit —
      // a confirm tool you cannot preview is a delete you must take on faith.
      if (def.requiresApproval !== false) throw new Error(`[agent/tools] ${where}: confirm tools never use the approval flag`);
      if (typeof def.preview !== 'function') throw new Error(`[agent/tools] ${where}: confirm tools must declare a read-only preview`);
      if (!def.audit || typeof def.audit.action !== 'string') {
        throw new Error(`[agent/tools] ${where}: confirm tools must declare an audit action`);
      }
      if (def.cacheTtlSeconds !== 0) throw new Error(`[agent/tools] ${where}: confirm tools must never be cached`);
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

// --- Phase 1 (v2 rebuild): the model-facing surface -------------------------------
//
// The Phase 4.5 per-question shortlist that used to live here is GONE, by decision
// (handoff 3.1 + Decision #15). It was a size fix for an 8k-tokens/minute free tier, and
// it cost more than it bought: all the mutating tools were hidden behind an Arabic
// imperative heuristic, and a false negative in that heuristic is indistinguishable
// from the agent simply having no such tool -- the exact bug this rebuild fixes.
//
// The surface is now the catalogue itself: listDefinitions() returns every read tool on
// every turn and adds the action tools iff AI_AGENT_ALLOW_MUTATIONS is true. That switch
// is a global WRITE KILL-SWITCH, not a per-message filter: it is the only thing that
// hides an action from the model. Its cost is measured, not guessed -- graph.js weighs
// the bound surface with approximateSchemaTokens() and agentService writes the number
// into the AGENT_TURN audit row, so the revisit trigger in Decision #15 has data from
// the first turn.

/**
 * Approximate the schema weight of a tool set, for the measurement recorded in
 * graph.js. `/4` is the usual chars-per-token rule of thumb and is only ever used
 * for a comment and a test bound — never for a decision.
 */
function approximateSchemaTokens(defs) {
  const chars = defs.reduce((sum, def) => {
    const shape = {
      name: def.name,
      description: def.description,
      // Zod has no portable "describe this as JSON" without zod-to-json-schema, so
      // the field NAMES are the honest cheap proxy: the descriptions on them are
      // Arabic and dominate anyway.
      fields: Object.keys(def.schema.shape || {}),
    };
    return sum + JSON.stringify(shape).length;
  }, 0);
  return { chars, tokens: Math.round(chars / 4) };
}

/**
 * Strip JSON-Schema keywords Gemini rejects, without touching the Zod schema the
 * tool actually validates with.
 *
 * WHY THIS EXISTS: the generateContent API accepts only a small subset of JSON
 * Schema and rejects the WHOLE request — 400, every tool, every turn — on the
 * first keyword it does not know. Found live, one at a time:
 *   exclusiveMinimum  ← z.number().int().positive()  (Zod 4 default target)
 *   propertyNames     ← z.record() / z.object().catchall()
 *   const / examples  ← z.literal(), z.enum()'s examples
 * That last one matters most: a single tool in a 15-tool payload carrying one bad
 * keyword made the agent answer "تعذّر الوصول إلى مزوّد الذكاء الاصطناعي" to
 * EVERY question — which is why this runs over the WHOLE catalogue at boot rather
 * than over whatever a turn happens to bind.
 *
 * This is a WHITELIST for the same reason: enumerating the rejected keywords
 * means the next Zod release that emits something new breaks the agent silently
 * again, and the failure looks like a provider outage rather than a schema bug.
 *
 * `exclusiveMinimum: 0` becomes `minimum: 1`: every id here is a 1-based
 * autoincrement key, so the stricter bound is the honest one. Anything dropped
 * only narrows what the model is TOLD; execute() still validates with the tool's
 * own Zod schema, so a bad argument is rejected exactly as before. This stops
 * the provider refusing to look at the tools — it does not weaken the tools.
 */
const GEMINI_SCHEMA_KEYS = new Set([
  'type', 'format', 'title', 'description', 'default',
  'enum', 'items', 'properties', 'required', 'additionalProperties',
  'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength',
  'pattern', 'nullable',
]);

function stripUnsupportedSchemaKeys(schema) {
  const convert = (node) => {
    if (Array.isArray(node)) return node.map(convert);
    if (!node || typeof node !== 'object') return node;

    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'exclusiveMinimum') {
        if (typeof value === 'number') out.minimum = value + 1;
        continue;
      }
      if (key === 'exclusiveMaximum') {
        if (typeof value === 'number') out.maximum = value - 1;
        continue;
      }
      if (!GEMINI_SCHEMA_KEYS.has(key)) continue;

      // `properties` is a MAP OF NAMES, not a schema node: its keys are argument
      // names (attemptId, courseSlug, …) and every one of them must survive. The
      // generic branch would whitelist-filter those names away and produce
      // `properties: {}` — a tool that declares three arguments and tells the model
      // it takes none. So the map is passed through by key and only its VALUES are
      // converted.
      if (key === 'properties') {
        const map = {};
        for (const [name, sub] of Object.entries(value || {})) {
          map[name] = convert(sub);
        }
        out.properties = map;
        continue;
      }

      // additionalProperties: false is how Zod says "reject unknown keys"; Gemini
      // only understands the boolean, and a schema object here is not supported.
      if (key === 'additionalProperties' && typeof value !== 'boolean') {
        out.additionalProperties = false;
        continue;
      }
      out[key] = convert(value);
    }
    return out;
  };

  /**
   * Cross-check: Gemini requires every name in `required` to exist in
   * `properties`. Zod can emit a `required` entry for an optional key under some
   * unions/refinements, and Gemini answers 400 "property is not defined" for the
   * WHOLE payload — so the two lists are reconciled here rather than trusted.
   */
  const pruneRequired = (node) => {
    if (Array.isArray(node)) {
      node.forEach(pruneRequired);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (node.properties) {
      node.required = Array.isArray(node.required)
        ? node.required.filter((name) => Object.prototype.hasOwnProperty.call(node.properties, name))
        : [];
      if (node.required.length === 0) delete node.required;
    }
    if (node.items) pruneRequired(node.items);
  };

  try {
    const json = z.toJSONSchema(schema, { io: 'input' });
    // Gemini rejects a parameterless object schema outright ("parameters" with no
    // properties), and it must still be an object-typed schema either way.
    if (!json.properties) json.properties = {};
    const converted = convert(json);
    pruneRequired(converted);

    // Positive control, enforced in CODE rather than only in a test: a strip that
    // silently emptied `properties` would leave a schema that is valid, leak-free
    // and completely useless — the model would be told the tool takes no arguments.
    // Zod's `$schema`/title keys are dropped by the whitelist, so anything still
    // here came from the real schema.
    if (!converted.properties || Object.keys(converted.properties).length === 0) {
      // A parameterless tool is legitimate only if the source said so.
      if (json.properties && Object.keys(json.properties).length > 0) {
        throw new Error(`stripUnsupportedSchemaKeys erased the arguments of a ${Object.keys(json.properties).length}-argument schema`);
      }
    }
    return converted;
  } catch (err) {
    // A schema Zod cannot express, or one this strip would damage, falls back to
    // the Zod form. The vendor then reports the real problem instead of the model
    // being handed an empty tool — a loud failure beats a silently useless one.
    if (err && /erased the arguments/.test(String(err.message))) throw err;
    return schema;
  }
}

/**
 * Convert definitions to LangChain tools. `resolveContext(args, def)` supplies the
 * per-invocation context (at minimum { adminId } for mutations) — the graph
 * resolves the calling admin SERVER-SIDE, which is exactly why the authority to
 * mutate cannot be bypassed by the model: it is not part of the tool's arguments.
 *
 * `def` is passed as the second argument so a resolver can bind a decision to a
 * SPECIFIC tool (a confirmation token for one action must not authorise another).
 */
function toLangChainTools(defs = listDefinitions(), resolveContext = () => ({})) {
  const { tool } = require('@langchain/core/tools');
  return defs.map((def) => {
    // `await` on purpose: an authority check may need to hit the database (consuming
    // a single-use approval), and a sync-only resolver would force that check to
    // happen somewhere less safe. A non-promise return is awaited harmlessly.
    //
    // Phase 4.5: the per-process micro-cache is installed on the MODEL-FACING copy
    // only. A direct execute(def, …) caller (the tool unit tests, the DB suites)
    // keeps reaching the database, so an assertion about real query counts stays
    // meaningful instead of being satisfied by a cache nobody expected.
    const bound = def.kind === KIND_READ ? wrapReadDefinition(def) : def;
    return tool(async (args) => execute(bound, args, await resolveContext(args, def)), {
      name: def.name,
      description: def.description,
      // The MODEL is shown a plain JSON Schema with the keywords Gemini rejects
      // removed (see stripUnsupportedSchemaKeys). execute() below still validates
      // with the tool's own Zod schema, so this is a transport fix only.
      schema: stripUnsupportedSchemaKeys(def.schema),
    });
  });
}

module.exports = {
  readDefinitions,
  actionDefinitions,
  listDefinitions,
  getDefinition,
  toLangChainTools,
  toolNames: () => listDefinitions({ includeActions: true }).map((d) => d.name),
  // The measurement graph.js records per turn for the AGENT_TURN audit row (Decision Q3):
  // the weight of the model-facing surface that turn bound.
  approximateSchemaTokens,
};
