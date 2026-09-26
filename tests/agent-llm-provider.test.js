'use strict';

/**
 * Phase 3 — the LLM provider layer with failover (pure, offline).
 * Phase 4.5 — plus the retired-model policy: a provider whose configured MODEL is
 * gone (`404 model_not_found`) is retired for the process lifetime, while a bad key
 * (401) still must NOT spend the fallback.
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
  classifyFailure,
  isRetriable,
  isProviderConfigError,
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

// The vendors' real wording for a retired model id, copied from the live probes:
// Groq answers 404 `model_not_found`, Gemini 400 "is not found for API version
// v1beta, or is not supported for generateContent". The classifier keys on these
// strings, so the tests must use the same shapes production sees.
const GROQ_MODEL_GONE = 'model_not_found: The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.';
const GEMINI_MODEL_GONE = 'models/gemini-2.5-flash is not found for API version v1beta, or is not supported for generateContent.';

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

// ── Phase 4.5: a retired model must not kill the tier ────────────────────────

test('classifyFailure separates transient, provider_config and request', () => {
  for (const status of [408, 409, 425, 429, 500, 502, 503, 504]) {
    assert.equal(classifyFailure(httpError(status)), 'transient', `${status} is transient`);
  }
  assert.equal(classifyFailure({ code: 'ECONNRESET', message: 'socket hang up' }), 'transient');
  assert.equal(classifyFailure({ code: 'UND_ERR_CONNECT_TIMEOUT', message: 'timeout' }), 'transient');

  // Retired models, in both vendors' real wording: Groq 404 `model_not_found`
  // (verified live) and Gemini 404 "is not found for API version v1beta, or is not
  // supported for generateContent" (also verified live — Gemini reports a retired
  // model as 404, which is why that wording lives in the 404 list).
  assert.equal(classifyFailure(httpError(404, GROQ_MODEL_GONE)), 'provider_config');
  assert.equal(classifyFailure(httpError(404, GEMINI_MODEL_GONE)), 'provider_config');
  assert.equal(classifyFailure(httpError(404, 'The model gemini-1.5-flash does not exist')), 'provider_config');
  assert.equal(classifyFailure(httpError(404, 'model/some-model is not found')), 'provider_config');
  assert.equal(classifyFailure(httpError(404, 'The model is no longer available')), 'provider_config');
  // Groq's 400-shaped variant of the same fact.
  assert.equal(classifyFailure(httpError(400, 'model_decommissioned: this model is gone')), 'provider_config');
  assert.equal(classifyFailure(httpError(400, 'invalid model: unsupported model id')), 'provider_config');
  assert.equal(classifyFailure(httpError(400, 'model_not_found')), 'provider_config');

  // A bad key or malformed request: the fallback must NOT be spent on these.
  for (const status of [400, 401, 403, 422, 451]) {
    assert.equal(classifyFailure(httpError(status)), 'request', `${status} is a request error`);
  }
  // A 404 with no "model gone" wording stays a request error: a wrong path must not
  // silently disable an otherwise healthy provider. Same for a 400 whose wording is
  // request-shaped — the bare "is not found" phrase only counts on a 404, where the
  // vendor is talking about a model, never about a request body field.
  assert.equal(classifyFailure(httpError(404, 'unrecognized request url')), 'request');
  assert.equal(classifyFailure(httpError(400, 'field transcriptId is not found in the request body')), 'request');
  assert.equal(classifyFailure('not even an error'), 'unknown');
  assert.equal(classifyFailure(new Error('something else broke')), 'unknown');

  assert.equal(isProviderConfigError(httpError(404, GROQ_MODEL_GONE)), true);
  assert.equal(isProviderConfigError(httpError(401, 'bad key')), false);
  // The Phase 3 contract is unchanged: 404 is never "worth the fallback", it is
  // either a request error or a provider-config one — both handled without one.
  assert.equal(isRetriable(httpError(404, GROQ_MODEL_GONE)), false);
});


test('a retired primary model (404 model_not_found) falls through to the fallback', async () => {
  await withBothProviders(async () => {
    const seen = [];
    const outcome = await invokeWithFailover(async (model, provider) => {
      seen.push(provider);
      if (provider === 'groq') throw httpError(404, GROQ_MODEL_GONE);
      return `answer from ${provider}`;
    });

    assert.deepEqual(seen, ['groq', 'gemini']);
    assert.equal(outcome.provider, 'gemini', 'the retired primary must not be the answering provider');
    assert.equal(outcome.result, 'answer from gemini');
    assert.equal(outcome.attempts.length, 1);
    assert.equal(outcome.attempts[0].provider, 'groq');
    assert.equal(outcome.attempts[0].status, 404);
    assert.equal(outcome.attempts[0].kind, 'provider_config');
    assert.equal(outcome.attempts[0].retriable, false, 'a retired model is not transient');
  });
});

test('a retired model is retried by exactly zero later turns (call counter, not timing)', async () => {
  await withBothProviders(async () => {
    const calls = [];
    // Turn N: the primary answers 404, the fallback answers.
    await invokeWithFailover(async (model, provider) => {
      calls.push(provider);
      if (provider === 'groq') throw httpError(404, GROQ_MODEL_GONE);
      return 'turn 1';
    });

    // Turn N+1: the primary must not be contacted AT ALL — provable by counting the
    // callback invocations, so this cannot pass by accident on a timing window.
    const second = await invokeWithFailover(async (model, provider) => {
      calls.push(provider);
      return 'turn 2';
    });

    assert.deepEqual(calls, ['groq', 'gemini', 'gemini'], 'no second probe of the retired provider');
    assert.equal(calls.filter((name) => name === 'groq').length, 1);
    assert.equal(second.provider, 'gemini');
    assert.deepEqual(second.attempts, [], 'nothing failed on the second turn');
  });
});

test('a provider_config failure warns exactly once, with a key-free JSON line', async () => {
  await withBothProviders(async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (line) => warnings.push(String(line));
    try {
      // Three turns against a provider whose model is gone: three failures, of which
      // only the FIRST may log — a per-turn log line is the noise this phase removes.
      for (let turn = 0; turn < 3; turn += 1) {
        await invokeWithFailover(async (model, provider) => {
          if (provider === 'groq') {
            throw httpError(404, 'model_not_found: key gsk_abcdefghijklmnopqrstuvwxyz0123456789 rejected for llama-3.3-70b-versatile');
          }
          return 'ok';
        });
      }
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1, 'exactly one warning for the whole process lifetime');
    assert.match(warnings[0], /^\[WARN\] agent\.llm\.provider_config_error /);
    assert.match(warnings[0], /"provider":"groq"/);
    assert.match(warnings[0], /"reason":"model_not_found"/);
    assert.doesNotMatch(warnings[0], /gsk_[A-Za-z0-9]/, 'the log line must not carry key material');
  });
});

test('401 does NOT fail over: a bad key is not a provider-config problem', async () => {
  await withBothProviders(async () => {
    const seen = [];
    await assert.rejects(
      () =>
        invokeWithFailover(async (model, provider) => {
          seen.push(provider);
          throw httpError(401, 'invalid api key');
        }),
      (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.provider, 'groq');
        assert.equal(err.attempts.length, 1);
        return true;
      }
    );
    assert.deepEqual(seen, ['groq'], 'the fallback provider must never be contacted');

    // And the primary is NOT retired: a key can be fixed without a restart, while a
    // retired model cannot, so the next turn must still try it.
    const health = healthState();
    assert.equal(health.providers.find((p) => p.name === 'groq').usable, true);
  });
});

test('healthState reports the unusable provider and resetFailoverState clears it', async () => {
  await withBothProviders(async () => {
    await invokeWithFailover(async (model, provider) => {
      if (provider === 'groq') throw httpError(404, GROQ_MODEL_GONE);
      return 'ok';
    });

    const health = healthState();
    // The pre-existing keys must survive untouched.
    assert.equal(health.primary, 'groq');
    assert.deepEqual(health.order, ['groq', 'gemini']);
    assert.equal(health.cooldownMs, FAILOVER_COOLDOWN_MS);
    assert.equal(typeof health.primaryInCooldown, 'boolean');
    assert.ok('cooldownUntil' in health);

    const groq = health.providers.find((p) => p.name === 'groq');
    const gemini = health.providers.find((p) => p.name === 'gemini');
    assert.equal(groq.usable, false);
    assert.equal(groq.reason, 'model_not_found');
    assert.ok(Date.parse(groq.lastErrorAt) > Date.now() - 60_000, 'lastErrorAt is a real timestamp');
    assert.equal(groq.model, config.aiAgent.primaryModel);
    assert.equal(gemini.usable, true);
    assert.equal(gemini.reason, null);
    assert.equal(gemini.lastErrorAt, null);

    resetFailoverState();
    const after = healthState();
    assert.equal(after.providers.find((p) => p.name === 'groq').usable, true, 'reset clears the unusable map');
    assert.equal(after.providers.find((p) => p.name === 'groq').reason, null);
    assert.equal(after.primaryInCooldown, false, 'reset still clears the cooldown');
  });
});

test('when every provider model is gone the tier fails as ALL_PROVIDERS_FAILED', async () => {
  await withBothProviders(async () => {
    const calls = [];
    await assert.rejects(
      () =>
        invokeWithFailover(async (model, provider) => {
          calls.push(provider);
          if (provider === 'groq') throw httpError(404, GROQ_MODEL_GONE);
          throw httpError(404, GEMINI_MODEL_GONE);
        }),
      (err) => {
        assert.ok(err instanceof LlmProviderError, 'the caller must get ONE explicit tier failure');
        // agentService.js maps exactly this code to LLM_UNAVAILABLE.
        assert.equal(err.code, 'ALL_PROVIDERS_FAILED');
        assert.deepEqual(calls, ['groq', 'gemini'], 'both configured providers were tried once');
        assert.equal(err.meta.unusable.length, 2);
        assert.deepEqual(
          err.meta.unusable.map((entry) => entry.name).sort(),
          ['gemini', 'groq']
        );
        return true;
      }
    );

    // Once both are retired, later turns must not spend a single provider call.
    const later = [];
    await assert.rejects(
      () =>
        invokeWithFailover(async (model, provider) => {
          later.push(provider);
          return 'never';
        }),
      (err) => {
        assert.equal(err.code, 'ALL_PROVIDERS_FAILED');
        return true;
      }
    );
    assert.deepEqual(later, [], 'no provider call is wasted once every model is known to be gone');
  });
});


