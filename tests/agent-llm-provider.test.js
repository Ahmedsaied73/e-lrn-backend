'use strict';

/**
 * Phase 3 — the LLM provider layer with failover (pure, offline).
 *
 * No network and no real key is used: the failover wrapper takes the model call as
 * a callback, so these tests script provider failures exactly and assert the
 * decision logic (transient → fail over, permanent → stop, cooldown skips the
 * primary) instead of hoping a live provider misbehaves.
 */

process.env.REDIS_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config/env');
const {
  LlmProviderError,
  FAILOVER_COOLDOWN_MS,
  createModel,
  invokeWithFailover,
  isRetriable,
  statusOf,
  safeMessage,
  providerOrder,
  healthState,
  resetFailoverState,
} = require('../src/services/agent/llmProvider');

/**
 * Point the config at two fake-but-configured providers for the duration of a test.
 * `await`ed inside the helper on purpose: a sync try/finally around an ASYNC body
 * restores the snapshot before the body ever runs (the bug this helper had first).
 */
async function withBothProviders(fn) {
  const agent = config.aiAgent;
  const snapshot = {
    primary: agent.primary,
    groq: { ...agent.providers.groq },
    gemini: { ...agent.providers.gemini },
    groqApiKey: agent.groqApiKey,
    geminiApiKey: agent.geminiApiKey,
  };
  agent.primary = 'groq';
  agent.providers.groq = { configured: true };
  agent.providers.gemini = { configured: true };
  agent.groqApiKey = 'gsk_unitTestOnly000000000000000000000000000000000000';
  agent.geminiApiKey = 'AIzaUnitTestOnly000000000000000000000000';
  resetFailoverState();
  try {
    return await fn();
  } finally {
    agent.primary = snapshot.primary;
    agent.providers.groq = snapshot.groq;
    agent.providers.gemini = snapshot.gemini;
    agent.groqApiKey = snapshot.groqApiKey;
    agent.geminiApiKey = snapshot.geminiApiKey;
    resetFailoverState();
  }
}

function httpError(status, message = `provider said ${status}`) {
  const err = new Error(message);
  err.status = status;
  return err;
}

test('status extraction understands the shapes SDKs actually throw', () => {
  assert.equal(statusOf(httpError(429)), 429);
  assert.equal(statusOf({ statusCode: 503 }), 503);
  assert.equal(statusOf({ response: { status: 500 } }), 500);
  assert.equal(statusOf({ cause: { status: 502 } }), 502);
  assert.equal(statusOf(new Error('Request failed with status 429')), 429);
  assert.equal(statusOf(new Error('no status here')), null);
});

test('retriable means "worth spending the fallback on"', () => {
  for (const status of [429, 500, 502, 503, 504]) {
    assert.equal(isRetriable(httpError(status)), true, `status ${status} should fail over`);
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isRetriable(httpError(status)), false, `status ${status} must NOT fail over`);
  }
  assert.equal(isRetriable({ code: 'ECONNRESET', message: 'socket hang up' }), true);
  assert.equal(isRetriable({ code: 'EAI_AGAIN', message: 'dns' }), true);
});

test('a transient primary failure fails over to the fallback provider', async () => {
  await withBothProviders(async () => {
    const seen = [];
    const outcome = await invokeWithFailover(async (model, provider) => {
      seen.push(provider);
      if (provider === 'groq') throw httpError(429, 'rate limited');
      return `answer from ${provider}`;
    });

    assert.deepEqual(seen, ['groq', 'gemini']);
    assert.equal(outcome.provider, 'gemini');
    assert.equal(outcome.result, 'answer from gemini');
    assert.equal(outcome.attempts.length, 1);
    assert.equal(outcome.attempts[0].provider, 'groq');
    assert.equal(outcome.attempts[0].status, 429);
    assert.equal(outcome.attempts[0].retriable, true);
    resetFailoverState();
  });
});

test('a permanent failure is NOT retried on the fallback', async () => {
  await withBothProviders(async () => {
    const seen = [];
    await assert.rejects(
      () =>
        invokeWithFailover(async (model, provider) => {
          seen.push(provider);
          throw httpError(400, 'bad request');
        }),
      (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.provider, 'groq');
        assert.equal(err.attempts.length, 1);
        return true;
      }
    );
    // Burning the fallback on a malformed request would hide the real bug.
    assert.deepEqual(seen, ['groq']);
    resetFailoverState();
  });
});

test('after a transient primary failure the primary is skipped during the cooldown', async () => {
  await withBothProviders(async () => {
    await invokeWithFailover(async (model, provider) => {
      if (provider === 'groq') throw httpError(503);
      return 'fallback';
    });

    const health = healthState();
    assert.equal(health.primaryInCooldown, true);
    assert.equal(health.cooldownMs, FAILOVER_COOLDOWN_MS);
    assert.ok(Date.parse(health.cooldownUntil) > Date.now() - 1000);

    const seen = [];
    const second = await invokeWithFailover(async (model, provider) => {
      seen.push(provider);
      return 'ok';
    });
    assert.deepEqual(seen, ['gemini'], 'the primary must be skipped while cooling down');
    assert.equal(second.provider, 'gemini');

    resetFailoverState();
    assert.equal(healthState().primaryInCooldown, false);
  });
});

test('when nothing is configured the failure is explicit, not a crash', async () => {
  const agent = config.aiAgent;
  const snapshot = { primary: agent.primary, groq: { ...agent.providers.groq }, gemini: { ...agent.providers.gemini } };
  agent.primary = null;
  agent.providers.groq = { configured: false };
  agent.providers.gemini = { configured: false };
  try {
    assert.deepEqual(providerOrder(), []);
    await assert.rejects(
      () => invokeWithFailover(async () => 'never'),
      (err) => {
        assert.ok(err instanceof LlmProviderError);
        assert.equal(err.code, 'NOT_CONFIGURED');
        return true;
      }
    );
  } finally {
    agent.primary = snapshot.primary;
    agent.providers.groq = snapshot.groq;
    agent.providers.gemini = snapshot.gemini;
  }
});

test('a real model is constructed for each configured provider', () => {
  withBothProviders(() => {
    const groq = createModel('groq');
    const gemini = createModel('gemini');
    assert.equal(typeof groq.invoke, 'function');
    assert.equal(typeof gemini.invoke, 'function');
    assert.throws(() => createModel('openai'), /unknown provider/);
  });
});

test('error messages are scrubbed of key material before they can be logged', () => {
  const leaked = new Error('401 unauthorized: key gsk_abcdefghijklmnopqrstuvwxyz0123456789 is invalid');
  const scrubbed = safeMessage(leaked);
  assert.doesNotMatch(scrubbed, /gsk_(?!\*)/);
  assert.match(scrubbed, /gsk_\*\*\*/);

  assert.doesNotMatch(safeMessage(new Error('bad key AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567')), /AIzaSy/);
  assert.equal(safeMessage(new Error('x'.repeat(1000))).length, 300);
});
