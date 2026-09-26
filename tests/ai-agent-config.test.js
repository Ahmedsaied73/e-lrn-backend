'use strict';
/* AI Admin Agent — config + kill-switch contract (Phase 0).
 *
 * Pins the invariants that make the agent safe to ship, BEFORE any agent code
 * exists. The resolver is pure env parsing (no DB, no Redis, no network), so
 * each case runs in its own node process — src/config/env.js is module-cached
 * and warns once per process.
 *
 * Invariants under test:
 *   1. Default OFF: an absent AI_AGENT_ENABLED means the agent is absent.
 *   2. allowMutations can NEVER be true while `enabled` is false.
 *   3. A missing or placeholder key is never "configured".
 *   4. Primary provider is chosen by preference order over configured keys.
 *   5. Every numeric budget is clamped — a typo cannot create unbounded spend.
 *   6. A misconfiguration warns but never fails boot (spawn exits 0).
 *
 * Net-zero: reads process env only; touches no database or cache.
 * Run: npm test
 */
process.chdir(__dirname + '/..');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

// Boot-critical vars env.js refuses to start without (JWTSECRET, ADMIN_PASSWORD,
// the four Bunny keys). Agent vars are pinned to '' — an empty *value* shields
// every case from a developer's own .env, because dotenv never overrides a key
// that is already present in process.env.
const BASE_ENV = {
  JWTSECRET: 'agent-config-test-secret-1',
  ADMIN_PASSWORD: 'agent-config-test-pass',
  BUNNY_STREAM_LIBRARY_ID: '1',
  BUNNY_STREAM_API_KEY: 'test',
  BUNNY_STREAM_READ_ONLY_API_KEY: 'test',
  BUNNY_STREAM_TOKEN_KEY: 'test',
  NODE_ENV: 'test',
  AI_AGENT_ENABLED: '',
  AI_AGENT_ALLOW_MUTATIONS: '',
  AI_AGENT_MODEL_PRIMARY: '',
  AI_AGENT_MODEL_FALLBACK: '',
  GROQ_API_KEY: '',
  GEMINI_API_KEY: '',
  AI_AGENT_MAX_TOOL_CALLS: '',
  AI_AGENT_MAX_TOOL_RESULT_ROWS: '',
  AI_AGENT_MAX_ANSWER_TOKENS: '',
  AI_AGENT_TURN_TIMEOUT_MS: '',
  AI_AGENT_APPROVAL_TTL_MS: '',
  AI_AGENT_DAILY_TURN_BUDGET: '',
  AI_AGENT_CONVERSATION_RETENTION_DAYS: '',
};

function resolveConfig(overrides = {}) {
  const env = { ...process.env, ...BASE_ENV, ...overrides };
  const stdout = execFileSync(
    process.execPath,
    ['-e', "process.stdout.write(JSON.stringify(require('./src/config/env')));"],
    { env, encoding: 'utf8' }
  );
  return JSON.parse(stdout);
}

describe('AI Admin Agent — config + kill switch', () => {
  it('is OFF by default and mutations cannot outlive the agent switch', () => {
    const off = resolveConfig();
    assert.equal(off.features.aiAgent, false, 'default: features.aiAgent must be false');
    assert.equal(off.aiAgent.enabled, false, 'default: agent must be disabled');
    assert.equal(off.aiAgent.allowMutations, false, 'default: must be read-only');

    // The invariant that matters: asking for mutations while the kill switch is
    // off must NOT arm them, no matter what the mutation flag says.
    const sneaky = resolveConfig({ AI_AGENT_ALLOW_MUTATIONS: 'true' });
    assert.equal(sneaky.aiAgent.enabled, false, 'kill switch still off');
    assert.equal(sneaky.aiAgent.allowMutations, false, 'kill switch dominates mutations');
  });

  it('mirrors the switch into features.aiAgent when enabled', () => {
    const on = resolveConfig({ AI_AGENT_ENABLED: 'yes', GROQ_API_KEY: 'gsk_live_looking_key' });
    assert.equal(on.features.aiAgent, true, 'features.aiAgent follows the switch');
    assert.equal(on.aiAgent.enabled, true, 'enabled');
    assert.equal(on.aiAgent.allowMutations, false, 'read-only unless explicitly armed');
  });

  it('warns (never crashes) when enabled without any provider key', () => {
    // execFileSync throws on a non-zero exit, so a boot failure here fails the test.
    const bare = resolveConfig({ AI_AGENT_ENABLED: 'true' });
    assert.equal(bare.aiAgent.configured, false, 'no key means not configured');
    assert.equal(bare.aiAgent.primary, null, 'no provider selected');
    assert.deepEqual(
      bare.aiAgent.providers,
      { groq: { configured: false }, gemini: { configured: false } },
      'both providers report unconfigured'
    );
  });

  it('selects the primary provider by preference order over configured keys', () => {
    const groqFirst = resolveConfig({
      AI_AGENT_ENABLED: 'true',
      GROQ_API_KEY: 'gsk_live_key',
      GEMINI_API_KEY: 'gemini_live_key',
    });
    assert.equal(groqFirst.aiAgent.primary, 'groq', 'Groq preferred when both exist');
    assert.equal(groqFirst.aiAgent.configured, true, 'configured');

    const geminiOnly = resolveConfig({ AI_AGENT_ENABLED: 'true', GEMINI_API_KEY: 'gemini_live_key' });
    assert.equal(geminiOnly.aiAgent.primary, 'gemini', 'falls back to Gemini when Groq is absent');
    assert.equal(geminiOnly.aiAgent.providers.groq.configured, false, 'groq unconfigured');
  });

  it('never treats a placeholder key as configured', () => {
    const placeholder = resolveConfig({ AI_AGENT_ENABLED: 'true', GROQ_API_KEY: 'your_groq_api_key' });
    assert.equal(placeholder.aiAgent.providers.groq.configured, false, 'placeholder rejected');
    assert.equal(placeholder.aiAgent.primary, null, 'no provider to select');

    const bracketed = resolveConfig({ AI_AGENT_ENABLED: 'true', GEMINI_API_KEY: '[PROJECT-REF]-key' });
    assert.equal(bracketed.aiAgent.providers.gemini.configured, false, 'bracketed placeholder rejected');
  });

  it('clamps every budget so a typo cannot create unbounded spend', () => {
    const defaults = resolveConfig({ AI_AGENT_ENABLED: 'true' });
    assert.equal(defaults.aiAgent.maxToolCalls, 6, 'default tool-call cap');
    assert.equal(defaults.aiAgent.maxToolResultRows, 50, 'default row cap');
    assert.equal(defaults.aiAgent.maxAnswerTokens, 700, 'default answer cap');
    assert.equal(defaults.aiAgent.turnTimeoutMs, 25000, 'default turn timeout');
    assert.equal(defaults.aiAgent.approvalTtlMs, 300000, 'default approval TTL');
    assert.equal(defaults.aiAgent.dailyTurnBudget, 500, 'default daily budget');
    assert.equal(defaults.aiAgent.conversationRetentionDays, 90, 'default retention');

    const absurd = resolveConfig({
      AI_AGENT_ENABLED: 'true',
      AI_AGENT_MAX_TOOL_CALLS: '999',
      AI_AGENT_MAX_TOOL_RESULT_ROWS: '100000',
      AI_AGENT_MAX_ANSWER_TOKENS: '999999',
      AI_AGENT_TURN_TIMEOUT_MS: '3600000',
      AI_AGENT_APPROVAL_TTL_MS: '999999999',
      AI_AGENT_DAILY_TURN_BUDGET: '999999999',
      AI_AGENT_CONVERSATION_RETENTION_DAYS: '999999',
    });
    assert.equal(absurd.aiAgent.maxToolCalls, 10, 'tool-call cap clamped to max');
    assert.equal(absurd.aiAgent.maxToolResultRows, 200, 'row cap clamped to max');
    assert.equal(absurd.aiAgent.maxAnswerTokens, 4000, 'answer cap clamped to max');
    assert.equal(absurd.aiAgent.turnTimeoutMs, 120000, 'turn timeout clamped to max');
    assert.equal(absurd.aiAgent.approvalTtlMs, 1800000, 'approval TTL clamped to max');
    assert.equal(absurd.aiAgent.dailyTurnBudget, 100000, 'daily budget clamped to max');
    assert.equal(absurd.aiAgent.conversationRetentionDays, 3650, 'retention clamped to max');

    const silly = resolveConfig({
      AI_AGENT_ENABLED: 'true',
      AI_AGENT_MAX_TOOL_CALLS: 'abc',
      AI_AGENT_MAX_TOOL_RESULT_ROWS: '0',
      AI_AGENT_TURN_TIMEOUT_MS: '1',
      AI_AGENT_APPROVAL_TTL_MS: '10',
    });
    assert.equal(silly.aiAgent.maxToolCalls, 6, 'garbage falls back to the default');
    assert.equal(silly.aiAgent.maxToolResultRows, 1, 'zero clamps up to the minimum');
    assert.equal(silly.aiAgent.turnTimeoutMs, 5000, 'tiny timeout clamps up');
    assert.equal(silly.aiAgent.approvalTtlMs, 30000, 'tiny approval window clamps up');
  });

  it('ships model defaults that are known-good in this codebase', () => {
    const cfg = resolveConfig({ AI_AGENT_ENABLED: 'true' });
    // Both ids verified LIVE with tool calling on this project's keys (Phase 4.5).
    // The old Groq default `llama-3.3-70b-versatile` now 404s model_not_found — do
    // not restore it; `openai/gpt-oss-120b` (131k ctx) is the verified tool-caller.
    assert.equal(cfg.aiAgent.primaryModel, 'openai/gpt-oss-120b', 'Groq primary default is a verified tool-calling model');
    assert.equal(cfg.aiAgent.fallbackModel, 'gemini-3.6-flash', 'fallback reuses the grader model');
  });
});
