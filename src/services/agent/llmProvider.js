'use strict';

/**
 * llmProvider.js — dual-provider model access with failover (Phase 3).
 *
 * Two providers, one rule: a *transient* provider failure (429/5xx/timeout) must
 * not become the admin's problem, but a *permanent* one (bad request, bad key)
 * must NOT be retried on the fallback — retrying a malformed request just burns a
 * second quota and hides the real bug behind a confusing second error.
 *
 * The preference order is not hardcoded here: it comes from config.aiAgent
 * (Phase 0 resolves `primary` = first CONFIGURED provider), so adding a third
 * provider later is a config change, never a change to the graph.
 *
 * Phase 4.5 — a THIRD failure class: `provider_config`. A retired/renamed model
 * (`404 model_not_found`, `400 model_decommissioned`, Gemini's "is not found for
 * API version" 400/404) is neither transient nor a bad request. Retrying it on the
 * fallback every turn would kill the whole tier for the process lifetime, so it is
 * recorded once as UNUSABLE and every later turn skips that provider outright. The
 * retired model is a fact about the deployment's ENV, not about this request, so it
 * must not be re-discovered (and re-logged) on every turn.
 *
 * The LangChain SDKs are required lazily inside createModel(), which keeps them
 * off the boot path — the same property the rest of this repo relies on (see
 * src/services/aiGrader/provider.js). With AI_AGENT_ENABLED=false nothing here
 * is ever loaded.
 */

const config = require('../../config/env');

/** After a retriable primary failure, skip the primary for this long. */
const FAILOVER_COOLDOWN_MS = 60_000;

/** Statuses worth trying the next provider for. Everything else is permanent. */
const RETRIABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** Transport-level failures (no HTTP status at all) are also transient. */
const RETRIABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * Provider-vendor wording for "this model id is not a model anymore". Both
 * vendors send this as 404 (Groq: `model_not_found`) or 400 (Gemini: "is not found
 * for API version v1beta, or is not supported for generateContent").
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

/** Cooldown state. Module-level on purpose: it is a property of the process. */
let primaryCooldownUntil = 0;

/**
 * Providers whose configured MODEL the vendor refused, for the LIFETIME of the
 * process: name -> { reason, model, lastErrorAt }. Module-level for the same reason
 * as the cooldown, plus one more — re-probing a retired model on every turn costs a
 * round trip AND a log line per turn, which is exactly the noise this phase removes.
 * Cleared only by resetFailoverState() (the test seam), so a config fix means a
 * restart, which is honest: env is read once at boot anyway.
 */
const unusableProviders = new Map();

/** Providers in preference order, configured ones only. */
function providerOrder() {
  const agent = config.aiAgent;
  const order = [agent.primary, agent.primary === 'groq' ? 'gemini' : 'groq'];
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

/** The model id a provider is currently configured with (for diagnostics only). */
function modelIdFor(providerName) {
  const agent = config.aiAgent;
  return providerName === 'groq' ? agent.primaryModel : agent.fallbackModel;
}

/**
 * A message safe to log or to show: truncated, and with anything that looks like
 * an API key removed. Provider errors can echo request metadata back.
 */
function safeMessage(err) {
  return String((err && err.message) || err || 'unknown error')
    .replace(/gsk_[A-Za-z0-9_-]+/g, 'gsk_***')
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, 'AIza***')
    .slice(0, 300);
}

/**
 * Build one chat model. A fresh instance per call keeps failover stateless and
 * avoids a bound-model holding a stale client after a provider switch.
 * temperature 0 because an administrative answer must be reproducible.
 */
function createModel(providerName) {
  const agent = config.aiAgent;
  if (providerName === 'groq') {
    const { ChatGroq } = require('@langchain/groq');
    return new ChatGroq({
      apiKey: agent.groqApiKey,
      model: agent.primaryModel,
      temperature: 0,
      maxRetries: 0, // retries are OUR job: we switch provider instead
      maxTokens: agent.maxAnswerTokens,
    });
  }
  if (providerName === 'gemini') {
    const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
    return new ChatGoogleGenerativeAI({
      apiKey: agent.geminiApiKey,
      model: agent.fallbackModel,
      temperature: 0,
      maxRetries: 0,
      maxOutputTokens: agent.maxAnswerTokens,
    });
  }
  throw new LlmProviderError('UNKNOWN_PROVIDER', `unknown provider "${providerName}"`);
}

/**
 * Record a provider as unusable and warn about it exactly ONCE per process.
 *
 * The log line is JSON with a fixed vocabulary and a redacted message: it must be
 * greppable in production ("agent.llm.provider_config_error") and must never carry
 * key material, since a provider error can echo request metadata back.
 */
function markProviderUnusable(provider, err) {
  const firstTime = !unusableProviders.has(provider);
  const reason = configReasonOf(err);
  unusableProviders.set(provider, {
    reason,
    model: modelIdFor(provider),
    lastErrorAt: Date.now(),
  });
  if (firstTime) {
    console.warn(`[WARN] agent.llm.provider_config_error ${JSON.stringify({ provider, reason })}`);
  }
}

/** Snapshot of the unusable map for diagnostics / error metadata. Never a key. */
function unusableDetail() {
  return [...unusableProviders.entries()].map(([name, entry]) => ({
    name,
    model: entry.model,
    reason: entry.reason,
    lastErrorAt: new Date(entry.lastErrorAt).toISOString(),
  }));
}

/**
 * Run `invoke(model, providerName)` with failover.
 *
 * The callback shape (rather than this module building messages/graphs) is what
 * keeps provider concerns out of the graph: the graph composes whatever it needs,
 * and only the *choice of provider* lives here.
 *
 * Returns { result, provider, attempts }. Throws LlmProviderError('ALL_PROVIDERS_
 * FAILED') when no usable provider can answer (all transient, or every configured
 * model retired), and rethrows the original error (tagged with `attempts`) when a
 * failure is permanent — the caller must be able to tell "the model refused" from
 * "the model was busy". agentService.js branches on exactly this code, so
 * ALL_PROVIDERS_FAILED must stay the one code used for "the whole tier is down".
 */
async function invokeWithFailover(invoke) {
  const order = providerOrder();
  if (!order.length) {
    throw new LlmProviderError(
      'NOT_CONFIGURED',
      'no LLM provider is configured (set GROQ_API_KEY or GEMINI_API_KEY)'
    );
  }

  const primary = order[0];
  const attempts = [];

  // Two independent skips, applied by NAME rather than by position: once the
  // primary is dropped (unusable and/or cooling down) the next provider becomes
  // first in line and must NOT inherit either skip, or a single 429 on the primary
  // would silently disable the fallback too. When the unusable filter empties the
  // list the loop below never runs and the shared ALL_PROVIDERS_FAILED throw at the
  // end reports it — one exit for "the tier is down", never a second error type.
  const candidates = order.filter((name) => !unusableProviders.has(name));
  const now = Date.now();
  // The primary is skipped only inside its cooldown window.
  const ordered = candidates.filter((name) => name !== primary || now >= primaryCooldownUntil);

  for (const provider of ordered) {
    const isPrimary = provider === primary;
    try {
      const result = await invoke(createModel(provider), provider);
      if (isPrimary) primaryCooldownUntil = 0;
      return { result, provider, attempts };
    } catch (err) {
      const kind = classifyFailure(err);
      attempts.push({
        provider,
        status: statusOf(err),
        code: codeOf(err),
        retriable: kind === 'transient',
        kind,
        message: safeMessage(err),
      });

      if (kind === 'provider_config') {
        // Not the request's fault and not fixable by retrying: retire this
        // provider for the process and let the next one answer this same call.
        markProviderUnusable(provider, err);
        continue;
      }
      if (kind !== 'transient') {
        // Permanent: do not spend the fallback on a request that cannot succeed.
        err.provider = provider;
        err.attempts = attempts;
        throw err;
      }
      if (isPrimary) primaryCooldownUntil = Date.now() + FAILOVER_COOLDOWN_MS;
    }
  }

  // One exit for "the tier is down", whatever the cause: ALL_PROVIDERS_FAILED is the
  // only code agentService.js maps to LLM_UNAVAILABLE (everything else becomes
  // LLM_ERROR), so a second code here would surface as a permanent-looking error.
  // In production BOTH causes mean the same thing to the admin — try again later —
  // while `attempts`/`unusable` tell an operator which one it actually was.
  const stillUsable = order.some((name) => !unusableProviders.has(name));
  const unusable = unusableDetail();
  const meta = { attempts };
  if (unusable.length) meta.unusable = unusable;

  throw new LlmProviderError(
    'ALL_PROVIDERS_FAILED',
    stillUsable
      ? 'every configured LLM provider failed transiently'
      : 'every configured LLM provider is unusable: its configured model was rejected by the provider',
    meta
  );
}

/**
 * Wiring/latency diagnostics — never contains a key.
 *
 * `providers` is the per-provider detail added in Phase 4.5 (why an operator can
 * see "groq is down and it is not a cooldown, its model is gone" from one call).
 * The pre-existing keys are kept byte-for-byte: dashboards and the socket handler
 * already read them, and renaming a diagnostic key is a silent breakage.
 */
function healthState(now = Date.now()) {
  return {
    primary: config.aiAgent.primary,
    order: providerOrder(),
    primaryInCooldown: now < primaryCooldownUntil,
    cooldownUntil: primaryCooldownUntil ? new Date(primaryCooldownUntil).toISOString() : null,
    cooldownMs: FAILOVER_COOLDOWN_MS,
    providers: providerOrder().map((name) => {
      const unusable = unusableProviders.get(name);
      return {
        name,
        usable: !unusable,
        reason: unusable ? unusable.reason : null,
        lastErrorAt: unusable ? new Date(unusable.lastErrorAt).toISOString() : null,
        // Why it would be contacted at all: the model id that provider is pinned
        // to, so a retired default is visible without reading env.
        model: modelIdFor(name),
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
  unusableProviders.clear();
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
  healthState,
  resetFailoverState,
};
