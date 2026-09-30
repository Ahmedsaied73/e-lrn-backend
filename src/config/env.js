require('dotenv').config();

// [C-3] Fail fast — refuse to start if critical secrets are missing
if (!process.env.JWTSECRET) {
  console.error('[FATAL] JWTSECRET environment variable is not set. Server will not start.');
  process.exit(1);
}

// A copy-pasted example secret boots fine and makes every token forgeable.
// Same placeholder doctrine as refresh tokens below: fatal in production,
// loud warning in development.
const JWT_PLACEHOLDER_RE = /your_|placeholder|change_me|example|TODO/i;
if (JWT_PLACEHOLDER_RE.test(process.env.JWTSECRET)) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[FATAL] JWTSECRET looks like a placeholder. Set a real value in production.');
    process.exit(1);
  }
  console.warn('[WARN] JWTSECRET looks like a placeholder — set a real value.');
}

if (!process.env.ADMIN_PASSWORD) {
  console.error('[FATAL] ADMIN_PASSWORD environment variable is not set. Server will not start.');
  process.exit(1);
}

// ── Bunny Stream config validation ──────────────────────────────────────────
// All four are required for the video upload/playback/webhook features to work.
// See bunny-stream-integration-spec.md for what each key is used for.
const REQUIRED_BUNNY_VARS = [
  'BUNNY_STREAM_LIBRARY_ID',
  'BUNNY_STREAM_API_KEY',
  'BUNNY_STREAM_READ_ONLY_API_KEY', // doubles as webhook signing secret
  'BUNNY_STREAM_TOKEN_KEY',         // used for embed playback token generation
];

for (const varName of REQUIRED_BUNNY_VARS) {
  if (!process.env[varName]) {
    console.error(`[FATAL] ${varName} environment variable is not set. Server will not start.`);
    process.exit(1);
  }
}

// ── Refresh token secret resolution ─────────────────────────────────────────
// Refresh tokens must use a dedicated secret, NOT the access-token secret.
// Production refuses to start on a placeholder; development falls back to
// JWTSECRET (with a warning) so the server still boots.
const REFRESH_PLACEHOLDER_RE = /your_|placeholder|change_me|example|TODO/i;
function resolveRefreshSecret() {
  const candidate = process.env.REFRESH_TOKEN_SECRET;
  const looksPlaceholder = Boolean(candidate) && REFRESH_PLACEHOLDER_RE.test(candidate);

  if (looksPlaceholder) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[FATAL] REFRESH_TOKEN_SECRET looks like a placeholder. Set a real value in production.');
      process.exit(1);
    }
    console.warn('[WARN] REFRESH_TOKEN_SECRET looks like a placeholder — falling back to JWTSECRET. Set a real value.');
    return process.env.JWTSECRET;
  }

  return candidate || process.env.JWTSECRET;
}

// ── Rate-limit fallback gate ────────────────────────────────────────────────
// REQUIRE_REDIS_RATE_LIMIT (default false) selects the behaviour when a
// Redis-backed rate limiter's store is unavailable:
//   false (default) — fail-open with a per-instance in-memory fallback: the
//     limiter keeps counting requests locally so limiting still holds per
//     Node.js process (an unthrottled abuse surface is avoided during short
//     Redis blips). NOTE: the local counter is NOT shared across deployed
//     instances — multi-hour outages degrade to "N per instance", not global.
//   true — fail-closed: requests get HTTP 503 until the store recovers
//     (RATE_LIMIT_STORE_UNAVAILABLE). Set this on deployments where the API is
//     internet-exposed (production) and an unthrottled window is worse than a
//     short outage.
// When set true but Redis is disabled/unconfigured, the app cannot enforce it:
// fatal in production (refuse to boot silently unthrottled), warn in dev.
function resolveRateLimitRequireRedis() {
  const rawValue = String(process.env.REQUIRE_REDIS_RATE_LIMIT || '').trim().toLowerCase();
  const requireRedis = ['true', '1', 'yes', 'on'].includes(rawValue);
  if (!requireRedis) return false;

  const redisEnabled = String(process.env.REDIS_ENABLED || '').toLowerCase() === 'true';
  const url = process.env.REDIS_URL;
  const looksPlaceholder = Boolean(url) && REDIS_PLACEHOLDER_RE.test(url);
  if (!redisEnabled || !url || looksPlaceholder) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[FATAL] REQUIRE_REDIS_RATE_LIMIT=true but Redis is not enabled/configured. Set REDIS_ENABLED=true + a real REDIS_URL, or unset REQUIRE_REDIS_RATE_LIMIT.');
      process.exit(1);
    }
    console.warn('[WARN] REQUIRE_REDIS_RATE_LIMIT=true but Redis is not enabled/configured — rate limiting will fail OPEN.');
  }
  return true;
}

// ── Supabase Storage config (quiz question images) ──────────────────────────
// Uploads are proxied through POST /quizzes/images (ADMIN-only); the service
// key never leaves the server. Missing keys → dev warns + endpoint 501s;
// production refuses to start.
const SUPABASE_PLACEHOLDER_RE = /your_|placeholder|change_me|example|TODO|\[.*\]/i;
function resolveSupabase() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const looksPlaceholder = (v) => Boolean(v) && SUPABASE_PLACEHOLDER_RE.test(v);
  const configured = Boolean(url) && Boolean(serviceKey)
    && !looksPlaceholder(url) && !looksPlaceholder(serviceKey);

  if (!configured) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[FATAL] SUPABASE_URL / SUPABASE_SERVICE_KEY are not set. Quiz image upload requires them.');
      process.exit(1);
    }
    console.warn('[WARN] Supabase storage not configured — POST /quizzes/images will return 501.');
  }

  return {
    url: url || null,
    serviceKey: serviceKey || null,
    bucket: process.env.SUPABASE_QUIZ_BUCKET || 'quiz-images',
    configured,
  };
}

// ── Redis config (Upstash-backed cache + future rate-limit/queue use) ───────
// REDIS_ENABLED=false (or missing/unreachable URL) means pure passthrough:
// caching and Redis-backed limits silently stay off, the app boots and serves.
// Production refuses to start only when Redis is explicitly enabled but the
// URL is missing or looks like a placeholder.
const REDIS_PLACEHOLDER_RE = /your_|placeholder|change_me|example|TODO|\[.*\]/i;
function resolveRedis() {
  const enabled = String(process.env.REDIS_ENABLED || '').toLowerCase() === 'true';
  const url = process.env.REDIS_URL;
  const looksPlaceholder = Boolean(url) && REDIS_PLACEHOLDER_RE.test(url);

  if (!enabled) {
    return { url: null, enabled: false, configured: false };
  }
  if (!url || looksPlaceholder) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[FATAL] REDIS_ENABLED=true but REDIS_URL is missing or a placeholder. Set a real Upstash URL.');
      process.exit(1);
    }
    console.warn('[WARN] REDIS_ENABLED=true but REDIS_URL is missing — Redis stays off (passthrough).');
    return { url: null, enabled: true, configured: false };
  }

  return { url, enabled: true, configured: true };
}

// ── AI Grader config (essay grading via Gemini + BullMQ) ────────────────────
// NEVER boot-critical: a missing key only disables AI grading (attempts fall
// back to the human inbox). Warnings only, in every environment.
function resolveAiGrader() {
  const apiKey = process.env.GEMINI_API_KEY || null;
  const model = process.env.AI_GRADER_MODEL || 'gemini-3.6-flash';
  const threshold = Number(process.env.AI_GRADER_CONFIDENCE_THRESHOLD);
  const timeoutMs = Number(process.env.AI_GRADER_TIMEOUT_MS);
  if (!apiKey) {
    console.warn('[WARN] GEMINI_API_KEY not set — AI essay grading disabled (human inbox only).');
  }
  return {
    apiKey,
    model,
    confidenceThreshold: Number.isFinite(threshold) && threshold >= 0 && threshold <= 1 ? threshold : 0.8,
    timeoutMs: Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 45000,
    configured: Boolean(apiKey),
  };
}

// ── AI Admin Agent (admin copilot: analytics + guarded, approved mutations) ──
// NEVER boot-critical (same doctrine as resolveAiGrader above): a missing
// GEMINI_API_KEY leaves the module `configured: false`, so the routes can answer
// with a clear Arabic configuration error instead of crashing boot.
//
// Phase 5 (handoff 3.5): a single vendor — Gemini, via @langchain/google-genai. The
// second provider and its key were removed entirely, so "failover" is no longer
// vendor-level: AI_AGENT_MODEL_PRIMARY answers, and AI_AGENT_MODEL_FALLBACK is the
// same vendor's older Flash tier for a transient failure. See llmProvider.js.
//
// Two INDEPENDENT switches, deliberately:
//   AI_AGENT_ENABLED         (default FALSE) — kill switch, checked at mount
//                            time. Disabled means NO routes/SSE/LLM calls at
//                            all — absent, never stubbed (module-removal test).
//   AI_AGENT_ALLOW_MUTATIONS (default FALSE) — read-only is the shipped
//                            default even when the agent is on. While false the
//                            mutating tools are not registered with the model,
//                            so no prompt (or prompt injection) can reach them.
// `allowMutations` can NEVER be true while `enabled` is false.
const AGENT_PLACEHOLDER_RE = /your_|placeholder|change_me|example|TODO|\[.*\]/i;
function agentSecret(name) {
  const raw = process.env[name];
  // '' and undefined both mean "unset" — and because dotenv never overrides an
  // already-present key, '' also shields a test/boot from a developer's .env.
  if (!raw || AGENT_PLACEHOLDER_RE.test(raw)) return null;
  return raw;
}
function clampAgentInt(rawValue, fallback, min, max) {
  // '' / null / undefined are "unset" — NOT zero. Number('') is 0, which is a
  // safe integer and would silently clamp every cap to its minimum (a
  // maxToolCalls of 1 instead of 6), so an absent env var must short-circuit to
  // the fallback before any numeric coercion.
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return fallback;
  const n = Number(rawValue);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
/**
 * House preference when AI_AGENT_PROVIDER_ORDER is absent.
 *
 * Phase 5 (handoff 3.5): Gemini is the ONLY vendor, so the order has exactly one
 * real value. The mechanism is kept rather than deleted because it is the seam the
 * failover walks (llmProvider.providerOrder()) and because unknown names still have
 * to be DROPPED rather than inventing a provider — but with one vendor the env var
 * can no longer change anything, which is worth knowing before debugging it.
 */
const DEFAULT_PROVIDER_ORDER = Object.freeze(['gemini']);

function resolveAiAgent() {
  const enabled = resolveFlag(process.env.AI_AGENT_ENABLED, false);
  const geminiApiKey = agentSecret('GEMINI_API_KEY');

  const providers = {
    gemini: { configured: Boolean(geminiApiKey) },
  };
  // Primary = first CONFIGURED provider in preference order. The failover wrapper
  // walks this list on 429/5xx, so adding a vendor later is a one-line change here —
  // never a change inside the agent graph.
  //
  // The order is env-driven (AI_AGENT_PROVIDER_ORDER) rather than hardcoded so a
  // provider added later cannot silently be pinned last — but with Gemini the only
  // vendor (Phase 5) this list can only ever resolve to ['gemini']. Unknown names are
  // DROPPED, so a typo cannot invent a provider, and the installed-model sentence
  // that used to live here is now moot: there is no second vendor to compare against.
  // No env value at all means "use the house preference"; an env value is
  // authoritative even when every name in it is garbage.
  const rawOrder = String(process.env.AI_AGENT_PROVIDER_ORDER ?? '').trim();
  const requestedOrder = (rawOrder || DEFAULT_PROVIDER_ORDER.join(','))
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name && providers[name]);
  // Any provider the order forgot is still appended, so a partially specified (or
  // entirely nonsensical) order can never leave `configured` false while a key
  // exists. Appending only UNCONFIGURED providers is what keeps the published order
  // to the vendors that can actually answer — a name in the order is a preference,
  // not a claim that a credential exists.
  for (const name of Object.keys(providers)) {
    if (!requestedOrder.includes(name) && providers[name].configured) requestedOrder.push(name);
  }
  const primary = requestedOrder.find((name) => providers[name].configured) || null;
  const configured = primary !== null;

  if (enabled && !configured) {
    console.warn('[WARN] AI_AGENT_ENABLED=true but GEMINI_API_KEY is not set — the agent will answer with a configuration error (no boot failure).');
  }

  return {
    enabled,
    // Kill switch dominates: mutations can never outlive the agent switch.
    allowMutations: enabled && resolveFlag(process.env.AI_AGENT_ALLOW_MUTATIONS, false),
    configured,
    primary,
    providers,
    // The resolved failover order, published so llmProvider.js walks THIS list
    // instead of keeping its own copy of the preference.
    providerOrder: requestedOrder,
    geminiApiKey,
    // Model ids are the two ATTEMPTS of the single vendor (Phase 5), in order:
    // primary first, then the older Flash tier for a transient failure. Both ids were
    // verified LIVE against this project's key by listing the vendor catalogue
    // (models/gemini-3.7-flash and models/gemini-3.6-flash are both present), which
    // is the check handoff 3.5 asks for before a model id may become a default.
    // Do not "restore" a non-Flash or long-retired id: a retired one answers
    // 404 model_not_found, which the provider layer retires for the process and the
    // admin then sees as an outage.
    primaryModel: process.env.AI_AGENT_MODEL_PRIMARY || 'gemini-3.7-flash',
    fallbackModel: process.env.AI_AGENT_MODEL_FALLBACK || 'gemini-3.6-flash',
    // Budgets/caps — every one CLAMPED, because a typo in an env var must never
    // be able to turn one admin question into unbounded LLM/DB spend.
    maxToolCalls: clampAgentInt(process.env.AI_AGENT_MAX_TOOL_CALLS, 6, 1, 10),
    maxToolResultRows: clampAgentInt(process.env.AI_AGENT_MAX_TOOL_RESULT_ROWS, 50, 1, 200),
    // CHARS, not rows, and that is the whole point: the row cap above bounds how
    // many records ship, but a tool result is re-serialized into EVERY model call
    // of the turn, so 50 wide rows get paid for again on each step. Measured live
    // on this schema: a NORMAL 50-row read is 8.8k chars, and a 200-row wide
    // select is 85.7k — so a 12,000-char default is a no-op for ordinary answers
    // and only bites the pathological ones. Clamp bounds: 2k floor (below that the
    // answer is useless), 60k ceiling (a deliberate "give me everything" admin,
    // still ~15k tokens).
    maxToolResultChars: clampAgentInt(process.env.AI_AGENT_MAX_TOOL_RESULT_CHARS, 12000, 2000, 60000),
    maxAnswerTokens: clampAgentInt(process.env.AI_AGENT_MAX_ANSWER_TOKENS, 700, 128, 4000),
    // 25s default (was 45s): the graph aborts a hung provider per call, so a lower
    // budget fails the turn FAST instead of holding the SSE stream open until the
    // client gives up. Clamp bounds are unchanged (5s floor / 120s ceiling).
    turnTimeoutMs: clampAgentInt(process.env.AI_AGENT_TURN_TIMEOUT_MS, 25000, 5000, 120000),
    approvalTtlMs: clampAgentInt(process.env.AI_AGENT_APPROVAL_TTL_MS, 5 * 60 * 1000, 30 * 1000, 30 * 60 * 1000),
    // Phase 3 (handoff 3.3): lifetime of a preview-then-confirm token for the
    // destructive tools (deletes, broadcast). The token is an AgentApproval row;
    // the ceiling is approvals.js MAX_TTL_MS (30 min) — requestApproval rejects
    // anything larger, so the clamp must never exceed it. Default 5 minutes: the
    // token only has to survive ONE admin reply, and a long window widens the
    // window an unattended console has a spendable delete sitting in it.
    confirmationTtlMinutes: clampAgentInt(process.env.AI_AGENT_CONFIRMATION_TTL_MINUTES, 5, 1, 30),
    dailyTurnBudget: clampAgentInt(process.env.AI_AGENT_DAILY_TURN_BUDGET, 500, 1, 100000),
    conversationRetentionDays: clampAgentInt(process.env.AI_AGENT_CONVERSATION_RETENTION_DAYS, 30, 7, 3650),
    // Memory retention (Phase 7, Decisions #21–22): same 30-day window as
    // conversations, clamped the same way — a typo in the env var shortens the
    // window, never widens it. 0 is reserved for "the job is disabled" like the
    // conversation pruner, so the floor is 1 here and pruneExpiredMemories checks
    // for non-positive separately.
    memoryRetentionDays: clampAgentInt(process.env.AI_AGENT_MEMORY_RETENTION_DAYS, 30, 1, 3650),
  };
}

// ── Optional feature modules (building blocks) ─────────────────────────────
// Each module reads enabled here; absence means the approved default (true =
// current behavior preserved). Restart to change. See plans/ai-grader-plan.md
// and the notifications plan for the per-module contract. Payments is the
// exceptions: PAYMENTS_ENABLED and AI_AGENT_ENABLED default to FALSE (see
// resolvePaymob / resolveAiAgent below).

// ── Paymob payments (course purchases, D3/D16) ─────────────────────────────
// Feature-gated by PAYMENTS_ENABLED (default FALSE — today's free-enrollment
// behavior is preserved until keys are provisioned). When enabled, ALL four
// credentials are required AND non-placeholder: missing keys are fatal in
// production and self-disable (with a warning) in development. The secret/HMAC
// keys never leave the server — only `publicKey` is ever safe to expose.
const PAYMOB_PLACEHOLDER_RE = /your_|placeholder|change_me|example|TODO|\[.*\]/i;
function resolvePaymob() {
  const enabled = resolveFlag(process.env.PAYMENTS_ENABLED, false);
  const secretKey = process.env.PAYMOB_SECRET_KEY || null;
  const publicKey = process.env.PAYMOB_PUBLIC_KEY || null;
  const hmacSecret = process.env.PAYMOB_HMAC_SECRET || null;
  const looksPlaceholder = (v) => Boolean(v) && PAYMOB_PLACEHOLDER_RE.test(v);
  // Comma-separated payment-integration IDs (card, wallet) — must be positive ints.
  // Test/Live IDs must match the key environment (secret key) or Paymob rejects.
  const integrationIds = String(process.env.PAYMOB_INTEGRATION_IDS || '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isSafeInteger(n) && n > 0);

  if (!enabled) return { enabled: false, configured: false };

  const missing = [];
  if (!secretKey || looksPlaceholder(secretKey)) missing.push('PAYMOB_SECRET_KEY');
  if (!publicKey || looksPlaceholder(publicKey)) missing.push('PAYMOB_PUBLIC_KEY');
  if (!hmacSecret || looksPlaceholder(hmacSecret)) missing.push('PAYMOB_HMAC_SECRET');
  if (integrationIds.length === 0) missing.push('PAYMOB_INTEGRATION_IDS');

  if (missing.length > 0) {
    if (process.env.NODE_ENV === 'production') {
      console.error(`[FATAL] PAYMENTS_ENABLED=true but missing/invalid: ${missing.join(', ')}. Server will not start.`);
      process.exit(1);
    }
    console.warn(`[WARN] PAYMENTS_ENABLED=true but missing/invalid: ${missing.join(', ')} — payments stay OFF.`);
    return { enabled: false, configured: false };
  }

  return {
    enabled: true,
    configured: true,
    baseUrl: (process.env.PAYMOB_BASE_URL || 'https://accept.paymob.com').replace(/\/+$/, ''),
    secretKey,
    publicKey,
    hmacSecret,
    integrationIds,
    currency: process.env.PAYMOB_CURRENCY || 'EGP',
    // Hosted-checkout-session TTL (D4). Keep short: reuse rule (D5) only applies to a live session.
    intentionExpirySeconds: Number(process.env.PAYMOB_INTENTION_EXPIRY_SECONDS) || 3600,
  };
}
function resolveFlag(rawValue, defaultValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return defaultValue;
  return ['true', '1', 'yes', 'on'].includes(String(rawValue).trim().toLowerCase());
}

// Resolved once at boot: every consumer (routes, SSE handler, graph) reads this
// same frozen snapshot, so a mid-request env change can never split behaviour.
const aiAgent = resolveAiAgent();

const config = {
  jwt: {
    secret: process.env.JWTSECRET,
    expiry: process.env.JWT_EXPIRY || '15m',
    refreshSecret: resolveRefreshSecret(),
    refreshExpiry: process.env.REFRESH_TOKEN_EXPIRY || '7d'
  },
  supabase: resolveSupabase(),
  redis: resolveRedis(),
  rateLimit: {
    requireRedis: resolveRateLimitRequireRedis(),
  },
  aiGrader: resolveAiGrader(),
  aiAgent,
  sentry: {
    // Optional. Present → backend errors go to Sentry (src/config/sentry.js);
    // absent → that module no-ops. Never boot-critical.
    dsn: process.env.SENTRY_DSN || null,
  },
  features: {
    notifications: resolveFlag(process.env.NOTIFICATIONS_ENABLED, true),
    aiGrader: resolveFlag(process.env.AI_GRADER_ENABLED, true),
    payments: resolveFlag(process.env.PAYMENTS_ENABLED, false),
    // Second exception (default FALSE). Read at MOUNT time (app.js): while it is
    // false there is no agent router, no SSE endpoint and no LLM call at all.
    aiAgent: aiAgent.enabled,
  },
  paymob: resolvePaymob(),
  admin: {
    // [C-2] Credentials come from env only — no hardcoded fallbacks
    email: process.env.ADMIN_EMAIL || 'admin@elearning.com',
    password: process.env.ADMIN_PASSWORD
  },
  email: {
    service: process.env.EMAIL_SERVICE,
    user: process.env.EMAIL_USER,
    password: process.env.EMAIL_PASS
  },
  bunny: {
    // Library ID and full-access API key for CRUD and upload operations
    libraryId: process.env.BUNNY_STREAM_LIBRARY_ID,
    apiKey: process.env.BUNNY_STREAM_API_KEY,
    // Read-only API key doubles as the webhook signing secret (per Bunny docs)
    readOnlyApiKey: process.env.BUNNY_STREAM_READ_ONLY_API_KEY,
    // Token key for Embed Token Authentication (signed playback URLs)
    tokenKey: process.env.BUNNY_STREAM_TOKEN_KEY,
    // Playback token TTL in seconds — default: 21600 (6 hours)
    tokenTtlSeconds: Number(process.env.BUNNY_STREAM_TOKEN_TTL_SECONDS) || 21600,
    // Max upload size in bytes — defaults to 5GB; override per Bunny plan/needs
    maxUploadBytes: Number(process.env.BUNNY_VIDEO_MAX_BYTES) || 5 * 1024 * 1024 * 1024,
  }
};

module.exports = config;