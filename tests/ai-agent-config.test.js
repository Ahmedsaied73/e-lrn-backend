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
  AI_AGENT_PROVIDER_ORDER: '',
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
    const both = resolveConfig({
      AI_AGENT_ENABLED: 'true',
      GROQ_API_KEY: 'gsk_live_key',
      GEMINI_API_KEY: 'gemini_live_key',
    });
    // CHANGED: the default order is gemini-first (AI_AGENT_PROVIDER_ORDER). This used
    // to assert 'groq', back when primary was a hardcoded
    // `providers.groq.configured ? 'groq' : 'gemini'`. Primary is now the first
    // CONFIGURED name IN THE ORDER, so with both keys present Gemini leads.
    assert.deepEqual(both.aiAgent.providerOrder, ['gemini', 'groq'], 'default order is gemini-first');
    assert.equal(both.aiAgent.primary, 'gemini', 'the first name in the default order leads');
    assert.equal(both.aiAgent.configured, true, 'configured');

    // The order picks the primary, it does not filter availability: the first
    // CONFIGURED name wins, so an unconfigured leader falls through to the next.
    const groqOnly = resolveConfig({ AI_AGENT_ENABLED: 'true', GROQ_API_KEY: 'gsk_live_key' });
    assert.equal(groqOnly.aiAgent.primary, 'groq', 'Groq leads once it is the first configured name');
    assert.equal(groqOnly.aiAgent.providers.gemini.configured, false, 'gemini unconfigured');

    const geminiOnly = resolveConfig({ AI_AGENT_ENABLED: 'true', GEMINI_API_KEY: 'gemini_live_key' });
    assert.equal(geminiOnly.aiAgent.primary, 'gemini', 'Gemini is configured and leads');
    assert.equal(geminiOnly.aiAgent.providers.groq.configured, false, 'groq unconfigured');
  });

  it('resolves the provider order from AI_AGENT_PROVIDER_ORDER', () => {
    // Reversing the order flips the primary — with no code change, which is the whole
    // point of making the order env-driven.
    const reversed = resolveConfig({
      AI_AGENT_ENABLED: 'true',
      GROQ_API_KEY: 'gsk_live_key',
      GEMINI_API_KEY: 'gemini_live_key',
      AI_AGENT_PROVIDER_ORDER: 'groq,gemini',
    });
    assert.deepEqual(reversed.aiAgent.providerOrder, ['groq', 'gemini'], 'the order is respected verbatim');
    assert.equal(reversed.aiAgent.primary, 'groq', 'reversing the order flips the primary');

    // Unknown names are DROPPED, so a typo cannot invent a provider. Casing and
    // padding are normalised, because a hand-edited .env carries both.
    const typo = resolveConfig({
      AI_AGENT_ENABLED: 'true',
      GROQ_API_KEY: 'gsk_live_key',
      GEMINI_API_KEY: 'gemini_live_key',
      AI_AGENT_PROVIDER_ORDER: ' GROQ , mistral ,openai ',
    });
    assert.deepEqual(
      typo.aiAgent.providerOrder,
      ['groq', 'gemini'],
      'unknown names dropped, casing and padding normalised'
    );

    // A configured provider the order FORGOT is still appended, so a partially
    // specified order can never leave `configured` false while a key exists.
    const partial = resolveConfig({
      AI_AGENT_ENABLED: 'true',
      GROQ_API_KEY: 'gsk_live_key',
      GEMINI_API_KEY: 'gemini_live_key',
      AI_AGENT_PROVIDER_ORDER: 'gemini',
    });
    assert.deepEqual(partial.aiAgent.providerOrder, ['gemini', 'groq'], 'the unlisted provider is appended');
    assert.equal(partial.aiAgent.primary, 'gemini', 'the listed provider still leads');
    assert.equal(partial.aiAgent.configured, true, 'the appended provider is still reachable');

    // An order naming nothing real leaves the real providers reachable rather than
    // producing an empty order that nothing can be resolved against.
    const nonsense = resolveConfig({
      AI_AGENT_ENABLED: 'true',
      GROQ_API_KEY: 'gsk_live_key',
      AI_AGENT_PROVIDER_ORDER: 'openai,mistral',
    });
    assert.deepEqual(nonsense.aiAgent.providerOrder, ['groq'], 'only real providers survive');
    assert.equal(nonsense.aiAgent.primary, 'groq', 'primary is still resolved');
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
    // Phase 3.1 / C4: the confirmation window survives exactly one admin reply. Five
    // minutes was the specified value; 15 shipped by accident, so it is pinned now.
    assert.equal(defaults.aiAgent.confirmationTtlMinutes, 5, 'default confirm-token window');
    assert.equal(defaults.aiAgent.dailyTurnBudget, 500, 'default daily budget');
    assert.equal(defaults.aiAgent.conversationRetentionDays, 30, 'default retention');

    const absurd = resolveConfig({
      AI_AGENT_ENABLED: 'true',
      AI_AGENT_MAX_TOOL_CALLS: '999',
      AI_AGENT_MAX_TOOL_RESULT_ROWS: '100000',
      AI_AGENT_MAX_ANSWER_TOKENS: '999999',
      AI_AGENT_TURN_TIMEOUT_MS: '3600000',
      AI_AGENT_APPROVAL_TTL_MS: '999999999',
      AI_AGENT_CONFIRMATION_TTL_MINUTES: '999',
      AI_AGENT_DAILY_TURN_BUDGET: '999999999',
      AI_AGENT_CONVERSATION_RETENTION_DAYS: '999999',
    });
    assert.equal(absurd.aiAgent.maxToolCalls, 10, 'tool-call cap clamped to max');
    assert.equal(absurd.aiAgent.maxToolResultRows, 200, 'row cap clamped to max');
    assert.equal(absurd.aiAgent.maxAnswerTokens, 4000, 'answer cap clamped to max');
    assert.equal(absurd.aiAgent.turnTimeoutMs, 120000, 'turn timeout clamped to max');
    assert.equal(absurd.aiAgent.approvalTtlMs, 1800000, 'approval TTL clamped to max');
    // The ceiling is approvals.js MAX_TTL_MS (30 min): requestApproval REFUSES anything
    // larger, so a config that clamped higher would produce a preview with no token.
    assert.equal(absurd.aiAgent.confirmationTtlMinutes, 30, 'confirm window clamped to the ledger ceiling');
    assert.equal(absurd.aiAgent.dailyTurnBudget, 100000, 'daily budget clamped to max');
    assert.equal(absurd.aiAgent.conversationRetentionDays, 3650, 'retention clamped to max');

    const silly = resolveConfig({
      AI_AGENT_ENABLED: 'true',
      AI_AGENT_MAX_TOOL_CALLS: 'abc',
      AI_AGENT_MAX_TOOL_RESULT_ROWS: '0',
      AI_AGENT_TURN_TIMEOUT_MS: '1',
      AI_AGENT_APPROVAL_TTL_MS: '10',
      AI_AGENT_CONFIRMATION_TTL_MINUTES: '0',
    });
    assert.equal(silly.aiAgent.maxToolCalls, 6, 'garbage falls back to the default');
    assert.equal(silly.aiAgent.maxToolResultRows, 1, 'zero clamps up to the minimum');
    assert.equal(silly.aiAgent.turnTimeoutMs, 5000, 'tiny timeout clamps up');
    assert.equal(silly.aiAgent.approvalTtlMs, 30000, 'tiny approval window clamps up');
    // A zero window would issue a token that is already expired: unusable, not secure.
    assert.equal(silly.aiAgent.confirmationTtlMinutes, 1, 'zero confirm window clamps up to a minute');
  });

  it('ships model defaults that are known-good in this codebase', () => {
    const cfg = resolveConfig({ AI_AGENT_ENABLED: 'true' });
    // Both ids verified LIVE with tool calling on this project's keys (Phase 4.5).
    // The default pairing follows the default provider ORDER (gemini first), so
    // the primary id is a Gemini model and the fallback is the Groq one. Asserted
    // against providerOrder rather than hardcoded, so changing the preference does
    // not require editing this test to keep it meaningful.
    assert.equal(cfg.aiAgent.providerOrder[0], 'gemini', 'gemini is the default first choice');
    assert.equal(cfg.aiAgent.primaryModel, 'gemini-3.6-flash', 'primary default is a verified tool-calling model');
    assert.equal(cfg.aiAgent.fallbackModel, 'openai/gpt-oss-120b', 'fallback is the verified Groq tool-caller');
  });
});
