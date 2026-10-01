'use strict';

/**
 * llmProvider.js — one vendor, two model ATTEMPTS, with failover (Phase 5).
 *
 * Phase 5 (handoff 3.5): a single vendor remains, so this is no longer a multi-vendor
 * layer. Gemini answers via @langchain/google-genai, and "failover" means the SAME
 * vendor's older Flash tier answering when the primary model fails transiently —
 * `AI_AGENT_MODEL_PRIMARY`, then `AI_AGENT_MODEL_FALLBACK`.
 *
 * One rule survives the change: a *transient* provider failure (429/5xx/timeout)
 * must not become the admin's problem, but a *permanent* one (bad request, bad key)
 * must NOT be retried on the second attempt — retrying a malformed request just
 * burns a second quota and hides the real bug behind a confusing second error.
 *
 * The attempts are not hardcoded here: they come from config.aiAgent (the provider
 * order, then the two model ids), so changing a model is an env change, never a
 * change to the graph — and the state below is keyed per ATTEMPT rather than per
 * vendor, because two attempts now share one vendor name.
 *
 * Phase 4.5 — a THIRD failure class: `provider_config`. A retired/renamed model
 * (`404 model_not_found`, `400 model_decommissioned`, Gemini's "is not found for
 * API version" 400/404) is neither transient nor a bad request. Retrying it every
 * turn would kill that attempt for the process lifetime, so it is recorded once as
 * UNUSABLE and every later turn skips it outright. The retired model is a fact about
 * the deployment's ENV, not about this request, so it must not be re-discovered (and
 * re-logged) on every turn.
 *
 * The LangChain SDK is required lazily inside createModel(), which keeps it off the
 * boot path — the same property the rest of this repo relies on (see
 * src/services/aiGrader/provider.js). With AI_AGENT_ENABLED=false nothing here is
 * ever loaded.
 */

const config = require('../../config/env');

/** After a retriable primary failure, skip the primary for this long. */
const FAILOVER_COOLDOWN_MS = 60_000;

/** Statuses worth trying the next provider for. Everything else is permanent. */
const RETRIABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** Transport-level failures (no HTTP status at all) are also transient. */
const RETRIABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * Provider-vendor wording for "this model id is not a model anymore". The concrete
 * shape this deployment actually hits is Gemini's 404 "is not found for API version
 * v1beta, or is not supported for generateContent"; the OpenAI-compatible spellings
 * (`model_not_found`, `model_decommissioned`) are kept because the classifier keys on
 * WORDING rather than on a vendor name, and a future vendor should not need this file
 * edited to be classified correctly.
 */
const MODEL_GONE_404_RE = /model_not_found|does not exist|no longer available|not found for API version|not supported for generateContent|is not found/i;
const MODEL_GONE_400_RE = /invalid model|model_decommissioned|unsupported model|model_not_found/i;

class LlmProviderError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'LlmProviderError';
    this.code = code;
    this.meta = meta;
  }
}

/** Cooldown state for the FIRST attempt. Module-level: a property of the process. */
let primaryCooldownUntil = 0;

/**
 * Attempts whose configured MODEL the vendor refused, for the LIFETIME of the process:
 * `vendor:model` -> { reason, provider, model, lastErrorAt }. Module-level for the same
 * reason as the cooldown, plus one more — re-probing a retired model on every turn costs
 * a round trip AND a log line per turn, which is exactly the noise this removes. Cleared
 * only by resetFailoverState() (the test seam), so a config fix means a restart, which is
 * honest: env is read once at boot anyway.
 *
 * Keyed per ATTEMPT, not per vendor: since Phase 5 both attempts live in one vendor, and
 * a per-vendor key would let a retired PRIMARY id mark the healthy fallback unusable too.
 */
const unusableAttempts = new Map();

/**
 * Providers in preference order, configured ones only.
 *
 * The order comes from config.aiAgent (which resolves
 * AI_AGENT_PROVIDER_ORDER, default gemini-first), so this is never a second,
 * drifting copy of the preference: if the order changes, only env.js changes.
 * The tail is the configured providers the order did not name, so adding a
 * provider can never leave it unreachable as a failover.
 */
function providerOrder() {
  const agent = config.aiAgent;
  const named = Array.isArray(agent.providerOrder) ? agent.providerOrder : [agent.primary];
  const order = [...named];
  for (const name of Object.keys(agent.providers)) {
    if (!order.includes(name)) order.push(name);
  }
  return order.filter((name) => name && agent.providers[name] && agent.providers[name].configured);
}

/**
 * HTTP status carried by SDK errors. SDKs disagree on where they put it
 * (status / statusCode / response.status / cause.status), so all are checked.
 */
function statusOf(err) {
  if (!err || typeof err !== 'object') return null;
  const candidates = [err.status, err.statusCode, err.response && err.response.status, err.cause && err.cause.status];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isSafeInteger(n) && n >= 100 && n < 600) return n;
  }
  const match = /\b(4\d\d|5\d\d)\b/.exec(String(err.message || ''));
  return match ? Number(match[1]) : null;
}

function codeOf(err) {
  if (!err || typeof err !== 'object') return null;
  return err.code || (err.cause && err.cause.code) || null;
}

/** Transient = worth spending the fallback on. */
function isRetriable(err) {
  const status = statusOf(err);
  if (status !== null) return RETRIABLE_STATUS.has(status);
  return RETRIABLE_CODES.has(codeOf(err));
}

/**
 * Which KIND of failure is this? The three classes drive three different actions,
 * so the classification has to happen before we decide anything:
 *
 *   transient       — the provider is busy or unreachable. Try the next provider
 *                     and cool the primary down; the same call may succeed later.
 *   provider_config — the model id in config is not served any more. No retry can
 *                     fix it: record the provider unusable for the process and
 *                     move on (Phase 4.5 — the retired-model kill switch).
 *   request         — 401/403/422 and every other 4xx: a bad key or a malformed
 *                     request. Rethrow immediately; the header comment above
 *                     explains why the fallback must NOT be spent on these.
 *
 * 404 is deliberately split by MESSAGE: a 404 with no "model gone" wording is an
 * ordinary request error (a wrong URL path, an unknown endpoint), and treating it
 * as a config error would silently disable a healthy provider. `unknown` (no
 * status and no transport code) is treated like `request`: rethrow.
 */
function classifyFailure(err) {
  const status = statusOf(err);
  const message = String((err && err.message) || '');

  if (status !== null) {
    if (RETRIABLE_STATUS.has(status)) return 'transient';
    if (status === 404 && MODEL_GONE_404_RE.test(message)) return 'provider_config';
    if (status === 400 && MODEL_GONE_400_RE.test(message)) return 'provider_config';
    if (status >= 400 && status < 500) return 'request';
    // A permanent 5xx we do not know (501/505/…): not the caller's fault, but not
    // something the fallback fixes either — `unknown` rethrows, like `request`.
    return 'unknown';
  }

  if (RETRIABLE_CODES.has(codeOf(err))) return 'transient';
  return 'unknown';
}

/** True when the provider rejected the configured MODEL ID (not the request). */
function isProviderConfigError(err) {
  return classifyFailure(err) === 'provider_config';
}

/**
 * A short, key-free token naming WHY a provider is unusable — this ends up in a
 * log line, so it must be a fixed vocabulary, never raw provider text (which can
 * echo request metadata back).
 */
function configReasonOf(err) {
  const message = String((err && err.message) || '').toLowerCase();
  if (/model_not_found|model_decommissioned|does not exist|no longer available|not found/.test(message)) {
    return 'model_not_found';
  }
  if (/invalid model|unsupported model/.test(message)) return 'invalid_model';
  if (/not supported for generatecontent/.test(message)) return 'unsupported_for_generate_content';
  return 'provider_config_error';
}

/** One failover attempt: a vendor plus the model id that will be asked. */
function attemptKey(providerName, modelId) {
  return `${providerName}:${modelId}`;
}

/**
 * The failover ATTEMPTS, in order: one entry per (vendor, model id).
 *
 * Phase 5 (handoff 3.5). With one vendor left, failover is no longer "another
 * company" — it is the primary MODEL failing transiently and the older fallback MODEL
 * answering the same call. Both halves come from config (the provider order, then the
 * two model ids), so a model change is an env change and this file never holds a
 * literal id. Duplicate attempts collapse: when primaryModel === fallbackModel there
 * is ONE attempt, not two identical ones (retrying the identical request can only
 * cost quota, never succeed).
 */
function failoverTargets() {
  const agent = config.aiAgent;
  const targets = [];
  for (const name of providerOrder()) {
    for (const modelId of [agent.primaryModel, agent.fallbackModel]) {
      if (!modelId) continue;
      const key = attemptKey(name, modelId);
      if (!targets.some((target) => target.key === key)) targets.push({ key, name, model: modelId });
    }
  }
  return targets;
}

/**
 * A message safe to log or to show: truncated, and with anything that looks like
 * an API key removed. Provider errors can echo request metadata back.
 *
 * The pattern list is deliberately vendor-SHAPED rather than vendor-filtered: the
 * Gemini `AIza…` form is the one this deployment uses, and the OpenAI-compatible
 * `gsk_…` form stays because a pasted key of the wrong shape is exactly the mistake
 * this scrub exists to make harmless.
 */
function safeMessage(err) {
  return String((err && err.message) || err || 'unknown error')
    .replace(/gsk_[A-Za-z0-9_-]+/g, 'gsk_***')
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, 'AIza***')
    .slice(0, 300);
}

/**
 * Build one chat model for one ATTEMPT. A fresh instance per call keeps failover
 * stateless and avoids a bound model holding a stale client after a model switch.
 * temperature 0 because an administrative answer must be reproducible.
 *
 * `modelId` is required in spirit: since Phase 5 there are two attempts on ONE vendor,
 * so a hardcoded id here would make the fallback a silent copy of the primary. The
 * parameter defaults to the primary id only so a direct caller (a diagnostic, a test)
 * cannot get `undefined` handed to the SDK.
 */
function createModel(providerName, modelId = null) {
  const agent = config.aiAgent;
  if (providerName === 'gemini') {
    const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
    return new ChatGoogleGenerativeAI({
      apiKey: agent.geminiApiKey,
      model: modelId || agent.primaryModel,
      temperature: 0,
      maxRetries: 0, // retries are OUR job: we switch model instead
      maxOutputTokens: agent.maxAnswerTokens,
    });
  }
  throw new LlmProviderError('UNKNOWN_PROVIDER', `unknown provider "${providerName}"`);
}

/**
 * Record an ATTEMPT as unusable and warn about it exactly ONCE per process.
 *
 * The log line is JSON with a fixed vocabulary and a redacted message: it must be
 * greppable in production ("agent.llm.provider_config_error") and must never carry
 * key material, since a provider error can echo request metadata back. The model id is
 * part of the line because with two attempts on one vendor the vendor name alone no
 * longer says which id was refused.
 */
function markAttemptUnusable(target, err) {
  const firstTime = !unusableAttempts.has(target.key);
  const reason = configReasonOf(err);
  unusableAttempts.set(target.key, {
    reason,
    provider: target.name,
    model: target.model,
    lastErrorAt: Date.now(),
  });
  if (firstTime) {
    console.warn(
      `[WARN] agent.llm.provider_config_error ${JSON.stringify({ provider: target.name, model: target.model, reason })}`
    );
  }
}

/** Snapshot of the unusable map for diagnostics / error metadata. Never a key. */
function unusableDetail() {
  return [...unusableAttempts.entries()].map(([key, entry]) => ({
    key,
    name: entry.provider,
    model: entry.model,
    reason: entry.reason,
    lastErrorAt: new Date(entry.lastErrorAt).toISOString(),
  }));
}

/**
 * Run `invoke(model, providerName, modelId)` with failover across the attempts.
 *
 * The callback shape (rather than this module building messages/graphs) is what
 * keeps provider concerns out of the graph: the graph composes whatever it needs,
 * and only the *choice of model* lives here.
 *
 * Returns { result, provider, model, attempts }. Throws LlmProviderError('ALL_PROVIDERS_
 * FAILED') when no usable attempt can answer (all transient, or every configured model
 * retired), and rethrows the original error (tagged with `attempts`) when a failure is
 * permanent — the caller must be able to tell "the model refused" from "the model was
 * busy". agentService.js branches on exactly this code, so ALL_PROVIDERS_FAILED must stay
 * the one code used for "the whole model tier is down".
 */
async function invokeWithFailover(invoke) {
  const targets = failoverTargets();
  if (!targets.length) {
    throw new LlmProviderError('NOT_CONFIGURED', 'no LLM provider is configured (set GEMINI_API_KEY)');
  }

  const primaryKey = targets[0].key;
  const attempts = [];

  // Two independent skips, applied by ATTEMPT KEY rather than by position: once the
  // primary is dropped (unusable, and/or cooling down) the next attempt becomes first
  // in line and must NOT inherit either skip, or a single 429 on the primary would
  // silently disable the fallback model too. When the unusable filter empties the list
  // the loop below never runs and the shared ALL_PROVIDERS_FAILED throw at the end
  // reports it — one exit for "the tier is down", never a second error type.
  const candidates = targets.filter((target) => !unusableAttempts.has(target.key));
  const now = Date.now();
  // The primary is skipped only inside its cooldown window.
  const ordered = candidates.filter((target) => target.key !== primaryKey || now >= primaryCooldownUntil);

  for (const target of ordered) {
    const isPrimary = target.key === primaryKey;
    try {
      const result = await invoke(createModel(target.name, target.model), target.name, target.model);
      if (isPrimary) primaryCooldownUntil = 0;
      return { result, provider: target.name, model: target.model, attempts };
    } catch (err) {
      const kind = classifyFailure(err);
      attempts.push({
        provider: target.name,
        model: target.model,
        status: statusOf(err),
        code: codeOf(err),
        retriable: kind === 'transient',
        kind,
        message: safeMessage(err),
      });

      if (kind === 'provider_config') {
        // Not the request's fault and not fixable by retrying: retire this ATTEMPT
        // for the process and let the next model answer this same call.
        markAttemptUnusable(target, err);
        continue;
      }
      if (kind !== 'transient') {
        // Permanent: do not spend the fallback on a request that cannot succeed.
        err.provider = target.name;
        err.model = target.model;
        err.attempts = attempts;
        throw err;
      }
      if (isPrimary) primaryCooldownUntil = Date.now() + FAILOVER_COOLDOWN_MS;
    }
  }

  // One exit for "the model tier is down", whatever the cause: ALL_PROVIDERS_FAILED is
  // the only code agentService.js maps to PROVIDER_UNAVAILABLE (everything else becomes
  // LLM_ERROR), so a second code here would surface as a permanent-looking error. In
  // production BOTH causes mean the same thing to the admin — try again later — while
  // `attempts`/`unusable` tell an operator which one it actually was.
  const stillUsable = targets.some((target) => !unusableAttempts.has(target.key));
  const unusable = unusableDetail();
  const meta = { attempts };
  if (unusable.length) meta.unusable = unusable;

  throw new LlmProviderError(
    'ALL_PROVIDERS_FAILED',
    stillUsable
      ? 'every configured model failed transiently'
      : 'every configured model is unusable: its configured id was rejected by the provider',
    meta
  );
}

/**
 * Wiring/latency diagnostics — never contains a key.
 *
 * `providers` is the per-ATTEMPT detail added in Phase 4.5 (why an operator can see
 * "the primary id is retired and it is not a cooldown, that model is gone" from one
 * call). Since Phase 5 there are two attempts on ONE vendor, so the entries are keyed
 * by (name, model) instead of by vendor — a per-vendor entry could not say WHICH model
 * was refused. The pre-existing keys are kept byte-for-byte: dashboards and the socket
 * handler already read them, and renaming a diagnostic key is a silent breakage.
 */
function healthState(now = Date.now()) {
  return {
    primary: config.aiAgent.primary,
    order: providerOrder(),
    primaryInCooldown: now < primaryCooldownUntil,
    cooldownUntil: primaryCooldownUntil ? new Date(primaryCooldownUntil).toISOString() : null,
    cooldownMs: FAILOVER_COOLDOWN_MS,
    providers: failoverTargets().map((target) => {
      const unusable = unusableAttempts.get(target.key);
      return {
        name: target.name,
        // Why this attempt exists at all: the id it will ask for, so a retired default
        // is visible without reading env.
        model: target.model,
        usable: !unusable,
        reason: unusable ? unusable.reason : null,
        lastErrorAt: unusable ? new Date(unusable.lastErrorAt).toISOString() : null,
      };
    }),
  };
}

/**
 * Test seam: cooldown AND unusable-set are process state, so tests must be able to
 * clear both. Clearing only the cooldown would leave a test that provoked a
 * provider_config error poisoning every later test in the same process.
 */
function resetFailoverState() {
  primaryCooldownUntil = 0;
  unusableAttempts.clear();
}

module.exports = {
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
  // The ordered attempts (vendor + model id). Exported for the same reason the old
  // modelIdFor was: agentService records WHICH model answered, and the failover it
  // walked must be readable without re-deriving it from config in a second place
  // (invokeWithFailover returns the answering model directly, so no caller has to).
  failoverTargets,
  healthState,
  resetFailoverState,
};
