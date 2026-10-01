'use strict';

/**
 * Phase 5 — the LLM provider layer: ONE vendor, two model attempts (handoff 3.5).
 *
 * What changed in this phase and is therefore what these tests are shaped around:
 * the second vendor was removed, so failover no longer means "ask a different
 * company" — it means the primary MODEL failing transiently and the older fallback
 * MODEL answering the same call. The state is keyed per ATTEMPT (vendor + model id),
 * which is the property that lets a retired primary id keep the fallback alive.
 *
 * Phase 4.5's policy is still pinned here: a model the vendor refuses
 * (`404 model_not_found`) is retired for the process lifetime, while a bad key (401)
 * must NOT spend the second attempt.
 *
 * No network and no real key: the failover wrapper takes the model call as a callback,
 * so these tests script failures exactly and assert the DECISION logic (transient →
 * fail over, permanent → stop, cooldown skips the primary) instead of hoping a live
 * provider misbehaves.
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
  failoverTargets,
  healthState,
  resetFailoverState,
} = require('../src/services/agent/llmProvider');

/**
 * Point the config at the shipped single-vendor shape with obviously-fake model ids,
 * for the duration of one test. `await`ed inside the helper on purpose: a sync
 * try/finally around an ASYNC body restores the snapshot before the body ever runs
 * (the bug this helper had first).
 */
async function withGemini(fn, { primaryModel = 'unit-primary-model', fallbackModel = 'unit-fallback-model' } = {}) {
  const agent = config.aiAgent;
  const snapshot = {
    primary: agent.primary,
    providerOrder: Array.isArray(agent.providerOrder) ? [...agent.providerOrder] : null,
    gemini: { ...agent.providers.gemini },
    geminiApiKey: agent.geminiApiKey,
    primaryModel: agent.primaryModel,
    fallbackModel: agent.fallbackModel,
  };
  agent.primary = 'gemini';
  agent.providerOrder = ['gemini'];
  agent.providers.gemini = { configured: true };
  agent.geminiApiKey = 'unitTestKeyShapeNotUsed000000000000000000';
  agent.primaryModel = primaryModel;
  agent.fallbackModel = fallbackModel;
  resetFailoverState();
  try {
    return await fn();
  } finally {
    agent.primary = snapshot.primary;
    if (snapshot.providerOrder) agent.providerOrder = snapshot.providerOrder;
    agent.providers.gemini = snapshot.gemini;
    agent.geminiApiKey = snapshot.geminiApiKey;
    agent.primaryModel = snapshot.primaryModel;
    agent.fallbackModel = snapshot.fallbackModel;
    resetFailoverState();
  }
}

function httpError(status, message = `provider said ${status}`) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// The vendor's real wording for a retired model id, copied from the live probes:
// Gemini answers 404/400 "… is not found for API version v1beta, or is not supported
// for generateContent". The classifier keys on wording, not on a vendor name, so the
// OpenAI-compatible `model_not_found` spelling is exercised too — a gateway that
// speaks it must classify correctly without this file being edited.
const MODEL_GONE_GEMINI =
  'models/gemini-2.5-flash is not found for API version v1beta, or is not supported for generateContent.';
const MODEL_GONE_OPENAI_SHAPED =
  'model_not_found: The model `some-retired-model` does not exist or you do not have access to it.';

test('status extraction understands the shapes SDKs actually throw', () => {
  assert.equal(statusOf(httpError(429)), 429);
  assert.equal(statusOf({ statusCode: 503 }), 503);
  assert.equal(statusOf({ response: { status: 500 } }), 500);
  assert.equal(statusOf({ cause: { status: 502 } }), 502);
  assert.equal(statusOf(new Error('Request failed with status 429')), 429);
  assert.equal(statusOf(new Error('no status here')), null);
});

test('retriable means "worth spending the fallback attempt on"', () => {
  for (const status of [429, 500, 502, 503, 504]) {
    assert.equal(isRetriable(httpError(status)), true, `status ${status} should fail over`);
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isRetriable(httpError(status)), false, `status ${status} must NOT fail over`);
  }
  assert.equal(isRetriable({ code: 'ECONNRESET', message: 'socket hang up' }), true);
  assert.equal(isRetriable({ code: 'EAI_AGAIN', message: 'dns' }), true);
});

test('a transient failure on the primary model fails over to the fallback MODEL', async () => {
  await withGemini(async () => {
    const seen = [];
    const outcome = await invokeWithFailover(async (model, provider, modelId) => {
      seen.push(modelId);
      if (modelId === 'unit-primary-model') throw httpError(429, 'rate limited');
      return `answer from ${modelId}`;
    });

    // Same vendor both times, different model: that IS the failover since Phase 5.
    assert.deepEqual(seen, ['unit-primary-model', 'unit-fallback-model']);
    assert.equal(outcome.provider, 'gemini');
    assert.equal(outcome.model, 'unit-fallback-model', 'the answering model is reported');
    assert.equal(outcome.result, 'answer from unit-fallback-model');
    assert.equal(outcome.attempts.length, 1);
    assert.equal(outcome.attempts[0].provider, 'gemini');
    assert.equal(outcome.attempts[0].model, 'unit-primary-model', 'the attempt names the failed model');
    assert.equal(outcome.attempts[0].status, 429);
    assert.equal(outcome.attempts[0].retriable, true);
  });
});

test('a permanent failure is NOT retried on the fallback attempt', async () => {
  await withGemini(async () => {
    const seen = [];
    await assert.rejects(
      () =>
        invokeWithFailover(async (model, provider, modelId) => {
          seen.push(modelId);
          throw httpError(400, 'bad request');
        }),
      (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.provider, 'gemini');
        assert.equal(err.model, 'unit-primary-model');
        assert.equal(err.attempts.length, 1);
        return true;
      }
    );
    // Burning the second attempt on a malformed request would hide the real bug.
    assert.deepEqual(seen, ['unit-primary-model']);
  });
});

test('after a transient primary failure the primary is skipped during the cooldown', async () => {
  await withGemini(async () => {
    await invokeWithFailover(async (model, provider, modelId) => {
      if (modelId === 'unit-primary-model') throw httpError(503);
      return 'fallback';
    });

    const health = healthState();
    assert.equal(health.primaryInCooldown, true);
    assert.equal(health.cooldownMs, FAILOVER_COOLDOWN_MS);
    assert.ok(Date.parse(health.cooldownUntil) > Date.now() - 1000);

    const seen = [];
    const second = await invokeWithFailover(async (model, provider, modelId) => {
      seen.push(modelId);
      return 'ok';
    });
    assert.deepEqual(seen, ['unit-fallback-model'], 'the primary must be skipped while cooling down');
    assert.equal(second.model, 'unit-fallback-model');

    resetFailoverState();
    assert.equal(healthState().primaryInCooldown, false);
  });
});


/**
 * The attempt list IS the failover, so it is pinned directly.
 *
 * Phase 5's whole safety property lives here: two attempts share one vendor name, so
 * anything keyed by vendor alone would let the primary's failure disable the fallback.
 */
test('failoverTargets() builds one attempt per (vendor, model), primary first', async () => {
  await withGemini(async () => {
    assert.deepEqual(
      failoverTargets().map((target) => [target.name, target.model]),
      [
        ['gemini', 'unit-primary-model'],
        ['gemini', 'unit-fallback-model'],
      ]
    );

    // Identical ids collapse: retrying the identical request can only cost quota.
    const agent = config.aiAgent;
    agent.fallbackModel = 'unit-primary-model';
    assert.deepEqual(failoverTargets().map((target) => target.model), ['unit-primary-model']);

    // No key at all means no attempts at all — the failover must never spend a call
    // on a vendor it has no credential for.
    agent.providers.gemini = { configured: false };
    assert.deepEqual(failoverTargets(), []);
  });
});

test('providerOrder() walks the configured order, and only configured providers', async () => {
  await withGemini(async () => {
    assert.deepEqual(providerOrder(), ['gemini'], 'the configured vendor is walked');

    const agent = config.aiAgent;
    agent.providers.gemini = { configured: false };
    assert.deepEqual(providerOrder(), [], 'an unconfigured vendor is not contacted');
    agent.providers.gemini = { configured: true };

    // A name the order never mentions cannot appear: with one real vendor the filter
    // is what stops a typo from inventing a provider.
    agent.providerOrder = ['gemini', 'mistral'];
    assert.deepEqual(providerOrder(), ['gemini'], 'a name with no config entry is dropped');
  });
});

test('when nothing is configured the failure is explicit, not a crash', async () => {
  const agent = config.aiAgent;
  const snapshot = {
    primary: agent.primary,
    providerOrder: Array.isArray(agent.providerOrder) ? [...agent.providerOrder] : null,
    gemini: { ...agent.providers.gemini },
  };
  agent.primary = null;
  agent.providerOrder = ['gemini'];
  agent.providers.gemini = { configured: false };
  try {
    assert.deepEqual(providerOrder(), []);
    await assert.rejects(
      () => invokeWithFailover(async () => 'never'),
      (err) => {
        assert.ok(err instanceof LlmProviderError);
        assert.equal(err.code, 'NOT_CONFIGURED');
        assert.match(err.message, /GEMINI_API_KEY/, 'the error names the key that is missing');
        return true;
      }
    );
  } finally {
    agent.primary = snapshot.primary;
    if (snapshot.providerOrder) agent.providerOrder = snapshot.providerOrder;
    agent.providers.gemini = snapshot.gemini;
  }
});

test('a real model is constructed per attempt, and the removed vendor is refused', () => {
  return withGemini(async () => {
    const primary = createModel('gemini', 'unit-primary-model');
    const fallback = createModel('gemini', 'unit-fallback-model');
    assert.equal(typeof primary.invoke, 'function');
    assert.equal(typeof fallback.invoke, 'function');
    // Two attempts must be two DIFFERENT models, or the fallback is a silent copy.
    assert.notEqual(primary.model, fallback.model, 'each attempt asks for its own id');

    // Phase 5's definition of done, as a test: the removed vendor has no branch left,
    // so the only possible answer is a typed refusal naming it.
    assert.throws(() => createModel('groq'), /unknown provider/, 'the removed vendor is not constructible');
    assert.throws(() => createModel('mistral'), /unknown provider/);
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


// ── Phase 4.5: a retired model must not kill the tier ───────────────────────────

test('classifyFailure separates transient, provider_config and request', () => {
  for (const status of [408, 409, 425, 429, 500, 502, 503, 504]) {
    assert.equal(classifyFailure(httpError(status)), 'transient', `${status} is transient`);
  }
  assert.equal(classifyFailure({ code: 'ECONNRESET', message: 'socket hang up' }), 'transient');
  assert.equal(classifyFailure({ code: 'UND_ERR_CONNECT_TIMEOUT', message: 'timeout' }), 'transient');

  // Retired models, in both wordings: the live Gemini spelling and the
  // OpenAI-compatible one a future gateway would use.
  assert.equal(classifyFailure(httpError(404, MODEL_GONE_OPENAI_SHAPED)), 'provider_config');
  assert.equal(classifyFailure(httpError(404, MODEL_GONE_GEMINI)), 'provider_config');
  assert.equal(classifyFailure(httpError(404, 'The model gemini-1.5-flash does not exist')), 'provider_config');
  assert.equal(classifyFailure(httpError(404, 'model/some-model is not found')), 'provider_config');
  assert.equal(classifyFailure(httpError(404, 'The model is no longer available')), 'provider_config');
  // The 400-shaped variants of the same fact.
  assert.equal(classifyFailure(httpError(400, 'model_decommissioned: this model is gone')), 'provider_config');
  assert.equal(classifyFailure(httpError(400, 'invalid model: unsupported model id')), 'provider_config');
  assert.equal(classifyFailure(httpError(400, 'model_not_found')), 'provider_config');

  // A bad key or malformed request: the second attempt must NOT be spent on these.
  for (const status of [400, 401, 403, 422, 451]) {
    assert.equal(classifyFailure(httpError(status)), 'request', `${status} is a request error`);
  }
  // A 404 with no "model gone" wording stays a request error: a wrong path must not
  // silently disable an otherwise healthy model. Same for a 400 whose wording is
  // request-shaped — the bare "is not found" phrase only counts on a 404, where the
  // vendor is talking about a model, never about a request body field.
  assert.equal(classifyFailure(httpError(404, 'unrecognized request url')), 'request');
  assert.equal(classifyFailure(httpError(400, 'field transcriptId is not found in the request body')), 'request');
  assert.equal(classifyFailure('not even an error'), 'unknown');
  assert.equal(classifyFailure(new Error('something else broke')), 'unknown');

  assert.equal(isProviderConfigError(httpError(404, MODEL_GONE_GEMINI)), true);
  assert.equal(isProviderConfigError(httpError(401, 'bad key')), false);
  // The contract is unchanged: 404 is never "worth the second attempt", it is either a
  // request error or a provider-config one — both handled without one.
  assert.equal(isRetriable(httpError(404, MODEL_GONE_GEMINI)), false);
});

test('a retired PRIMARY model falls through to the fallback attempt', async () => {
  await withGemini(async () => {
    const seen = [];
    const outcome = await invokeWithFailover(async (model, provider, modelId) => {
      seen.push(modelId);
      if (modelId === 'unit-primary-model') throw httpError(404, MODEL_GONE_GEMINI);
      return `answer from ${modelId}`;
    });

    assert.deepEqual(seen, ['unit-primary-model', 'unit-fallback-model']);
    assert.equal(outcome.model, 'unit-fallback-model', 'the retired attempt must not be the answering one');
    assert.equal(outcome.attempts.length, 1);
    assert.equal(outcome.attempts[0].model, 'unit-primary-model');
    assert.equal(outcome.attempts[0].status, 404);
    assert.equal(outcome.attempts[0].kind, 'provider_config');
    assert.equal(outcome.attempts[0].retriable, false, 'a retired model is not transient');
  });
});


test('a retired model is retried by exactly zero later turns (call counter, not timing)', async () => {
  await withGemini(async () => {
    const calls = [];
    // Turn N: the primary answers 404, the fallback answers.
    await invokeWithFailover(async (model, provider, modelId) => {
      calls.push(modelId);
      if (modelId === 'unit-primary-model') throw httpError(404, MODEL_GONE_GEMINI);
      return 'turn 1';
    });

    // Turn N+1: the retired attempt must not be contacted AT ALL — provable by counting
    // the callback invocations, so this cannot pass by accident on a timing window.
    const second = await invokeWithFailover(async (model, provider, modelId) => {
      calls.push(modelId);
      return 'turn 2';
    });

    assert.deepEqual(
      calls,
      ['unit-primary-model', 'unit-fallback-model', 'unit-fallback-model'],
      'no second probe of the retired attempt'
    );
    assert.equal(second.model, 'unit-fallback-model');
    assert.deepEqual(second.attempts, [], 'nothing failed on the second turn');
  });
});

test('a provider_config failure warns exactly once, with a key-free JSON line', async () => {
  await withGemini(async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (line) => warnings.push(String(line));
    try {
      // Three turns against a retired model: three failures, of which only the FIRST
      // may log — a per-turn log line is the noise this removes.
      for (let turn = 0; turn < 3; turn += 1) {
        await invokeWithFailover(async (model, provider, modelId) => {
          if (modelId === 'unit-primary-model') {
            throw httpError(404, 'model_not_found: key gsk_abcdefghijklmnopqrstuvwxyz0123456789');
          }
          return 'ok';
        });
      }
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1, 'exactly one warning for the whole process lifetime');
    assert.match(warnings[0], /^\[WARN\] agent\.llm\.provider_config_error /);
    assert.match(warnings[0], /"provider":"gemini"/);
    // The model id is part of the line because one vendor now has two attempts.
    assert.match(warnings[0], /"model":"unit-primary-model"/);
    assert.match(warnings[0], /"reason":"model_not_found"/);
    assert.doesNotMatch(warnings[0], /gsk_[A-Za-z0-9]/, 'the log line must not carry key material');
  });
});

test('401 does NOT fail over: a bad key is not a provider-config problem', async () => {
  await withGemini(async () => {
    const seen = [];
    await assert.rejects(
      () =>
        invokeWithFailover(async (model, provider, modelId) => {
          seen.push(modelId);
          throw httpError(401, 'invalid api key');
        }),
      (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.provider, 'gemini');
        assert.equal(err.model, 'unit-primary-model');
        assert.equal(err.attempts.length, 1);
        return true;
      }
    );
    assert.deepEqual(seen, ['unit-primary-model'], 'the second attempt must never be contacted');

    // And the attempt is NOT retired: a key can be fixed without a restart, while a
    // retired model cannot, so the next turn must still try it.
    const health = healthState();
    assert.equal(health.providers.find((p) => p.model === 'unit-primary-model').usable, true);
  });
});


test('healthState reports the unusable ATTEMPT and resetFailoverState clears it', async () => {
  await withGemini(async () => {
    await invokeWithFailover(async (model, provider, modelId) => {
      if (modelId === 'unit-primary-model') throw httpError(404, MODEL_GONE_GEMINI);
      return 'ok';
    });

    const health = healthState();
    // The pre-existing keys must survive untouched.
    assert.equal(health.primary, 'gemini');
    assert.deepEqual(health.order, ['gemini']);
    assert.equal(health.cooldownMs, FAILOVER_COOLDOWN_MS);
    assert.equal(typeof health.primaryInCooldown, 'boolean');
    assert.ok('cooldownUntil' in health);

    // Entries are keyed by (vendor, model) since Phase 5: one vendor, two attempts.
    const retired = health.providers.find((p) => p.model === 'unit-primary-model');
    const alive = health.providers.find((p) => p.model === 'unit-fallback-model');
    assert.equal(retired.name, 'gemini');
    assert.equal(retired.usable, false);
    assert.equal(retired.reason, 'model_not_found');
    assert.ok(Date.parse(retired.lastErrorAt) > Date.now() - 60_000, 'lastErrorAt is a real timestamp');
    // The property a per-vendor key would have broken: the fallback is untouched.
    assert.equal(alive.usable, true);
    assert.equal(alive.reason, null);
    assert.equal(alive.lastErrorAt, null);

    resetFailoverState();
    const after = healthState();
    assert.equal(after.providers.find((p) => p.model === 'unit-primary-model').usable, true, 'reset clears the unusable map');
    assert.equal(after.providers.find((p) => p.model === 'unit-primary-model').reason, null);
    assert.equal(after.primaryInCooldown, false, 'reset still clears the cooldown');
  });
});

test('when every configured model is gone the tier fails as ALL_PROVIDERS_FAILED', async () => {
  await withGemini(async () => {
    const calls = [];
    await assert.rejects(
      () =>
        invokeWithFailover(async (model, provider, modelId) => {
          calls.push(modelId);
          throw httpError(404, MODEL_GONE_GEMINI);
        }),
      (err) => {
        assert.ok(err instanceof LlmProviderError, 'the caller must get ONE explicit tier failure');
        // agentService.js maps exactly this code to PROVIDER_UNAVAILABLE.
        assert.equal(err.code, 'ALL_PROVIDERS_FAILED');
        assert.deepEqual(calls, ['unit-primary-model', 'unit-fallback-model'], 'both attempts were tried once');
        assert.equal(err.meta.unusable.length, 2);
        assert.deepEqual(
          err.meta.unusable.map((entry) => entry.key).sort(),
          ['gemini:unit-fallback-model', 'gemini:unit-primary-model']
        );
        return true;
      }
    );

    // Once both are retired, later turns must not spend a single provider call.
    const later = [];
    await assert.rejects(
      () =>
        invokeWithFailover(async (model, provider, modelId) => {
          later.push(modelId);
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

/**
 * §3.5 — the outage contract, at the layer that owns the decision.
 *
 * "No silent retries that hide the real state" is a claim about CALL COUNTS, so it is
 * asserted as one: both attempts are tried exactly once, the tier then fails with the
 * single code agentService maps to PROVIDER_UNAVAILABLE, and no third call is made.
 * Something that quietly retried would show up here as a longer `calls` array.
 */
test('a full outage spends exactly two attempts and then fails once (no retry loop)', async () => {
  await withGemini(async () => {
    const calls = [];
    await assert.rejects(
      () =>
        invokeWithFailover(async (model, provider, modelId) => {
          calls.push(modelId);
          throw httpError(503, 'service unavailable');
        }),
      (err) => {
        assert.equal(err.code, 'ALL_PROVIDERS_FAILED');
        assert.match(err.message, /transiently/, 'the cause is the transient one, not a retired model');
        assert.equal(err.meta.attempts.length, 2, 'both attempts are recorded for the operator');
        assert.equal(err.meta.unusable, undefined, 'a transient failure retires nothing');
        return true;
      }
    );
    assert.deepEqual(calls, ['unit-primary-model', 'unit-fallback-model']);
  });
});

