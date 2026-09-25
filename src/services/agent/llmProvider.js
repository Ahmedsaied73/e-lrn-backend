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
 * Run `invoke(model, providerName)` with failover.
 *
 * The callback shape (rather than this module building messages/graphs) is what
 * keeps provider concerns out of the graph: the graph composes whatever it needs,
 * and only the *choice of provider* lives here.
 *
 * Returns { result, provider, attempts }. Throws LlmProviderError('ALL_PROVIDERS_
 * FAILED') when every configured provider failed transiently, and rethrows the
 * original error (tagged with `attempts`) when a failure is permanent — the
 * caller must be able to tell "the model refused" from "the model was busy".
 */
async function invokeWithFailover(invoke) {
  const order = providerOrder();
  if (!order.length) {
    throw new LlmProviderError(
      'NOT_CONFIGURED',
      'no LLM provider is configured (set GROQ_API_KEY or GEMINI_API_KEY)'
    );
  }

  const now = Date.now();
  // The primary is skipped only inside its cooldown window.
  const ordered = order.filter((name, index) => index > 0 || now >= primaryCooldownUntil);
  const attempts = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const provider = ordered[index];
    const isPrimary = index === 0 && provider === order[0];
    try {
      const result = await invoke(createModel(provider), provider);
      if (isPrimary) primaryCooldownUntil = 0;
      return { result, provider, attempts };
    } catch (err) {
      const retriable = isRetriable(err);
      attempts.push({ provider, status: statusOf(err), code: codeOf(err), retriable, message: safeMessage(err) });

      if (!retriable) {
        // Permanent: do not spend the fallback on a request that cannot succeed.
        err.provider = provider;
        err.attempts = attempts;
        throw err;
      }
      if (isPrimary) primaryCooldownUntil = Date.now() + FAILOVER_COOLDOWN_MS;
    }
  }

  throw new LlmProviderError('ALL_PROVIDERS_FAILED', 'every configured LLM provider failed transiently', {
    attempts,
  });
}

/** Wiring/latency diagnostics — never contains a key. */
function healthState(now = Date.now()) {
  return {
    primary: config.aiAgent.primary,
    order: providerOrder(),
    primaryInCooldown: now < primaryCooldownUntil,
    cooldownUntil: primaryCooldownUntil ? new Date(primaryCooldownUntil).toISOString() : null,
    cooldownMs: FAILOVER_COOLDOWN_MS,
  };
}

/** Test seam: cooldown is process state, so tests must be able to clear it. */
function resetFailoverState() {
  primaryCooldownUntil = 0;
}

module.exports = {
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
};
