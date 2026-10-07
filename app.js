// bcrypt v5 runs on libuv's threadpool — default 4 workers serializes a login
// burst into ~100ms quanta. 16 removes the queue at 500 simultaneous logins.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

const express = require('express');
const cors = require('cors'); // Import CORS package
const cookieParser = require('cookie-parser'); // Import cookie-parser package
const Authrouter = require('./src/routes/auth');
const Userrouter = require('./src/routes/users');
const Courserouter = require('./src/routes/courses');
const SearchRouter = require('./src/routes/searchRoutes');
const enrollmentRoutes = require('./src/routes/enrollmentRoutes');
const videoProgressRoutes = require('./src/routes/videoProgressRoutes');
const assignmentRoutes = require('./src/routes/assignmentRoutes');
const quizRoutes = require('./src/routes/quizRoutes');
const adminRoutes = require('./src/routes/adminRoutes');
const { logger } = require('./src/middlewares/index');
const requestLogger = logger();
const rateLimit = require('express-rate-limit');
const { createRateLimitStore } = require('./src/integrations/redis/rateLimitStore');
const { isRedisEnabled } = require('./src/integrations/redis/redisClient');
const redisStoreEnabled = isRedisEnabled();
const helmet = require('helmet'); // S-5: security headers WITHOUT CSP (full CSP needs FE coordination)
const config = require('./src/config/env');
const requireRedisRateLimit = config.rateLimit.requireRedis;
const { initSentry, captureException, flush } = require('./src/config/sentry');
// Bunny Stream — new modules
const bunnyVideoRoutes = require('./src/routes/bunnyVideoRoutes');
const { handleBunnyWebhook } = require('./src/controllers/bunnyWebhookController');
const { startReconciliationJob } = require('./src/jobs/reconcileStaleVideos');
const { AppError } = require('./src/utils/AppError');

const { setupDefaultAdmin } = require('./src/config/setupAdmin');

// Express 4 does not catch rejected promises from async handlers — a throw
// inside `async (req,res)` becomes an unhandledRejection, which the
// process-level crash handler below treats as FATAL (exit 1). Patch Express's
// Layer so async rejections route to next(err) → the global error handler,
// keeping one bad route from taking down the whole API. Must run before the
// first request.
require('./src/utils/sanitizeAsyncErrors');

const app = express();
const port = process.env.PORT || 3005;

// Trust the first proxy hop (Railway's TLS-terminating router). Without this,
// `req.ip` is the proxy's address and the IP-keyed rate limiters + request
// logger see a single shared IP under load. `1` = trust one hop only; override
// with TRUST_PROXY for other topologies (e.g. "loopback" or a hop count).
app.set('trust proxy', process.env.TRUST_PROXY || 1);

// Initialize default admin on startup
setupDefaultAdmin().catch(console.error);

// Backend error tracking (DSN-gated no-op): must be called before the request
// middleware so Sentry's error paths are live when the handler fires.
initSentry();

// Define allowed frontend origins (single source of truth: src/config/cors.js).
// FRONTEND_URL may be comma-separated: prod Vercel domain plus any PR/preview
// deployments share the same cookie + JWT machinery without code changes.
// Vercel preview deploys get a fresh random subdomain per git push — the
// *.vercel.app wildcard (cors.js) keeps any branch/PR/preview origin working
// after the next deploy.
const { isAllowedOrigin } = require('./src/config/cors');
const csrfProtection = require('./src/middlewares/csrfProtection');

// Configure CORS for HttpOnly cookie credential support
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, server-to-server).
    if (!origin) return callback(null, true);
    return isAllowedOrigin(origin)
      ? callback(null, true)
      : callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Set-Cookie'],
  maxAge: 86400
}));

// Reject browser requests from origins we don't know. The `cors` middleware
// above can only omit CORS headers (the browser then blocks); serving an
// explicit 403 with a machine-readable code gives API clients a clear signal
// (and keeps these out of the global error handler's 500 bucket).
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden.',
      code: 'ORIGIN_NOT_ALLOWED',
    });
  }
  return next();
});

// CSRF defence on state-changing requests (cookie sessions). Verifies the
// request's Origin (or Referer) is a known origin — no FE changes required.
// See src/middlewares/csrfProtection.js.
app.use(csrfProtection);

// S-5: security headers. Content Security Policy (CSP) directives suited
// for this platform: Bunny stream embeds (*.mediadelivery.net, iframe.mediadelivery.net,
// *.b-cdn.net), Supabase (*.supabase.co), and self.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      fontSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://*.b-cdn.net', 'https://*.supabase.co', 'https://*.mediadelivery.net'],
      frameSrc: ["'self'", 'https://iframe.mediadelivery.net', 'https://*.mediadelivery.net'],
      mediaSrc: ["'self'", 'https://*.b-cdn.net', 'https://*.mediadelivery.net', 'blob:', 'data:'],
      frameAncestors: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));


// ── CRITICAL: Bunny webhook must be mounted BEFORE express.json() ─────────────
// The webhook handler needs the raw body Buffer for HMAC-SHA256 signature verification.
// express.json() would consume and parse the body before we can read it as raw bytes.
// express.raw() is scoped to this single path — it does NOT affect other routes.
//
// Scoped rate limiter (S3): runs FIRST so an attacker cannot spam status
// updates. The limiter only counts requests by IP — it never parses the body,
// so HMAC verification on the (possibly raw) body is unaffected. Distinct
// `rl:webhook:` Redis namespace keeps webhook hits off the global counter.
// 600 req / 5 min is generous for legit bursts (a whole course encoding can
// fire hundreds of callbacks) while still cutting a flood; HMAC is the real
// auth, the limiter is defense-in-depth. `keyGenerator` uses req.ip (already
// resolved through `trust proxy`).
const webhookLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 600,
  message: 'Too many webhook requests, please try again later.',
  ...(redisStoreEnabled ? { store: createRateLimitStore('rl:webhook:', { failClosed: requireRedisRateLimit }) } : {}),
});

app.post(
  '/webhooks/bunny/stream',
  webhookLimiter,
  express.raw({ type: 'application/json', limit: '2mb' }),
  handleBunnyWebhook
);

// ── Paymob payment callback (D13: mounted ONLY when payments are enabled) ───
// Same mounting rules as the Bunny webhook: pre-global-parser (Paymob signs
// field VALUES, not the raw body, so a scoped express.json() is safe) and
// pre-CSRF (server-to-server POST carries no Origin). The lazy require keeps
// core import-free of the payments module — deleting src/services/payments
// must never crash startup (removal test).
if (config.features && config.features.payments && config.paymob && config.paymob.enabled) {
  try {
    const { handlePaymobWebhook } = require('./src/controllers/paymobWebhookController');
    // HMAC arrives as ?hmac= and is verified inside the provider before any
    // state change. Handler policy (D10): 5xx on transient failure (Paymob
    // retries); 200 for handled events and confirmed forgeries.
    //
    // The scoped parser wrapper turns an unparseable body into a deliberate
    // 400: a garbage body can never be correlated to a payment, 400 is not a
    // retry signal (no retry storm), and attacker noise must not land in the
    // 5xx/Sentry stream. Genuine loss cases are covered by reconciliation.
    app.post(
      '/webhooks/paymob',
      webhookLimiter,
      (req, res, next) => express.json({ limit: '256kb' })(req, res, (err) => (
        err ? res.status(400).json({ received: false, error: 'Invalid JSON body.' }) : next()
      )),
      handlePaymobWebhook
    );
  } catch (err) {
    console.warn('[WARN] Paymob webhook failed to mount:', err.message);
  }
}

// Body cap 512kb: quiz payloads validate up to 256KB server-side, so the
// parser must accept that range (default 100kb would 413 legit admin saves).
app.use(express.json({ limit: '512kb' }));
app.use(cookieParser()); // Add cookie-parser middleware
// Add request logger middleware to log all requests
app.use(requestLogger);

// Set up rate limiter: maximum of 1000 requests per 15 minutes per IP.
// Raised from 100 (Sept 2026) — the default starved automated + real browsing
// (each admin page load costs ~2-3 API calls). Login stays at 20/15min below.
// Store: shared Redis when configured (correct across instances), otherwise the
// built-in MemoryStore. When Redis is down the store falls back to a per-instance
// in-memory counter (so limiting still holds locally) UNLESS REQUIRE_REDIS_RATE_LIMIT=true
// (then a dead store throws → 503 RATE_LIMIT_STORE_UNAVAILABLE). failClosed mirrors
// requireRedisRateLimit so both the throw and the 503 stay in lock-step.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  ...(redisStoreEnabled ? { store: createRateLimitStore(undefined, { failClosed: requireRedisRateLimit }) } : {}),
});

// Strict limiters for auth routes. SEPARATE buckets per endpoint: login,
// register, and refresh previously shared one `rl:<ip>` counter, so routine
// refresh traffic ate the login budget and logouts ended in 429s on re-login.
// Refresh gets headroom (cookie-bound + DB-matched + rotated: low abuse value,
// multi-tab rotation needs it); login/register keep 20 (brute-force posture).
function makeAuthLimiter(prefix, max) {
  return rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max,
    message: 'Too many login attempts from this IP, please try again later.',
    ...(redisStoreEnabled ? { store: createRateLimitStore(prefix, { failClosed: requireRedisRateLimit }) } : {}),
  });
}
const loginLimiter = makeAuthLimiter('rl:login:', 20);
const registerLimiter = makeAuthLimiter('rl:register:', 20);
const refreshLimiter = makeAuthLimiter('rl:refresh:', 60);

// ── Health probes (all mounted BEFORE the rate limiter — probes must never
//     be throttled; `/health` doubles as Railway's healthcheck path). Errors
//     are logged by the process-level handlers; the routes stay silent to
//     keep probes quiet in the request logs.
//     Liveness (`/healthz`) = process up, zero I/O. Readiness (`/readyz`) =
//     DB ping only (Redis fail-opens by design, so it never gates readiness,
//     and the process never kills itself on dependency degradation — the
//     orchestrator decides). `/health` is the legacy DB-ping healthcheck kept
//     byte-compatible for the test harness and CI.
const dbPing = async () => {
  const prisma = require('./src/config/db');
  await Promise.race([
    prisma.$queryRaw`SELECT 1`,
    new Promise((_, reject) => setTimeout(() => reject(new Error('db ping timeout')), 3000)),
  ]);
};

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { renderPrometheus } = require('./src/metrics/metrics');

function isMetricsAuthorized(req) {
  const configuredToken = process.env.METRICS_TOKEN ? String(process.env.METRICS_TOKEN).trim() : null;

  // 1. Dedicated METRICS_TOKEN via Bearer header, Basic auth, X-Metrics-Token, or query param (?token=)
  const candidateProvidedTokens = [];
  const authHeader = req.headers && req.headers['authorization'];
  if (authHeader) {
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch && bearerMatch[1]) {
      candidateProvidedTokens.push(bearerMatch[1].trim());
    }
    const basicMatch = authHeader.match(/^Basic\s+(.+)$/i);
    if (basicMatch && basicMatch[1]) {
      try {
        const creds = Buffer.from(basicMatch[1].trim(), 'base64').toString('utf8');
        const colonIdx = creds.indexOf(':');
        if (colonIdx !== -1) {
          const u = creds.slice(0, colonIdx).trim();
          const p = creds.slice(colonIdx + 1).trim();
          if (p) candidateProvidedTokens.push(p);
          if (u) candidateProvidedTokens.push(u);
        } else {
          candidateProvidedTokens.push(creds.trim());
        }
      } catch {
        // ignore malformed basic auth
      }
    }
  }

  if (req.headers && req.headers['x-metrics-token']) {
    candidateProvidedTokens.push(String(req.headers['x-metrics-token']).trim());
  }

  if (req.query && req.query.token) {
    candidateProvidedTokens.push(String(req.query.token).trim());
  }

  if (configuredToken && candidateProvidedTokens.length > 0) {
    const bufConfigured = Buffer.from(configuredToken);
    for (const token of candidateProvidedTokens) {
      const bufProvided = Buffer.from(token);
      if (bufConfigured.length === bufProvided.length && crypto.timingSafeEqual(bufConfigured, bufProvided)) {
        return true;
      }
    }
  }

  // 2. Admin JWT authentication (cookie or Bearer token)
  const candidateJwts = [];
  if (authHeader) {
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch && bearerMatch[1]) {
      candidateJwts.push(bearerMatch[1].trim());
    }
  }
  if (req.cookies) {
    if (req.cookies.accessToken) candidateJwts.push(String(req.cookies.accessToken).trim());
    if (req.cookies.token) candidateJwts.push(String(req.cookies.token).trim());
  }

  for (const jwtToken of candidateJwts) {
    try {
      const decoded = jwt.verify(jwtToken, config.jwt.secret);
      if (decoded && decoded.type === 'access' && decoded.role === 'ADMIN') {
        return true;
      }
    } catch {
      // try next candidate
    }
  }

  return false;
}

app.isMetricsAuthorized = isMetricsAuthorized;

app.get('/metrics', (req, res) => {
  if (!isMetricsAuthorized(req)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
    return res.status(401).json({
      success: false,
      error: 'Unauthorized. Metrics access requires a valid METRICS_TOKEN or admin authentication.',
      code: 'METRICS_AUTH_REQUIRED',
    });
  }

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(renderPrometheus());
});

app.get('/readyz', async (req, res) => {
  const started = Date.now();
  try {
    await dbPing();
    res.status(200).json({ status: 'ok', db: 'up', uptime: Math.round(process.uptime()), ms: Date.now() - started });
  } catch {
    res.status(503).json({ status: 'error', db: 'down', ms: Date.now() - started });
  }
});

app.get('/health', async (req, res) => {
  const started = Date.now();
  try {
    // Live DB ping — a 200 without this only proves the process is up, not
    // that it can serve requests (the pool collapsing is exactly what killed
    // it under load in the DB-audit incident).
    await dbPing();
    res.status(200).json({ status: 'ok', db: 'up', uptime: Math.round(process.uptime()), ms: Date.now() - started });
  } catch {
    res.status(503).json({ status: 'error', db: 'down', ms: Date.now() - started });
  }
});

// Apply rate limiter to all requests
app.use(limiter);

// Apply strict per-endpoint limiters to auth routes (login, register, and
// refresh — refresh is now strictly cookie-only, but keeps its own bucket so
// routine multi-tab rotation traffic never eats the login budget).
app.use('/auth/login', loginLimiter);
app.use('/auth/register', registerLimiter);
app.use('/auth/refresh-token', refreshLimiter);

// Existing routes
app.use("/user", Userrouter);
app.use('/enroll',enrollmentRoutes);
app.use('/auth', Authrouter);
app.use('/courses', Courserouter);
app.use('/search', SearchRouter);
app.use('/progress', videoProgressRoutes);
app.use('/assignments', assignmentRoutes);
app.use('/quizzes', quizRoutes);

// ── Admin console (all routes behind authenticateToken + authorizeAdmin) ─────
app.use('/admin', adminRoutes);

// ── Optional modules mount only when enabled (see src/config/env.js) ───────
// Disabled modules are not exposed at all (no stub routes, no handlers).
let enabledFeatures = {};
try {
  enabledFeatures = require('./src/config/env').features || {};
} catch {
  enabledFeatures = {};
}
if (enabledFeatures.notifications !== false) {
  // Guarded require mirrors the AI worker boot below: deleting the module
  // folder must never crash startup.
  try {
    app.use('/notifications', require('./src/routes/notificationRoutes'));
  } catch (err) {
    console.warn('[WARN] Notifications router failed to mount:', err.message);
  }
}

// Student payments (D13): mounted ONLY when the module is enabled — disabled
// means no /payments routes at all (never stubs). The lazy require keeps core
// import-free of the module, so deleting src/services/payments + its routes
// leaves boot green (the repo's removal test).
if (enabledFeatures.payments) {
  try {
    // Per-user limiter lives INSIDE the module's route file (it must run after
    // authenticateToken to key on the user id, and it keeps the module
    // self-contained so deleting the folder leaves no dangling dependency).
    app.use('/payments', require('./src/routes/paymentRoutes'));
  } catch (err) {
    console.warn('[WARN] Payments router failed to mount:', err.message);
  }
}

// ── AI admin agent (Phase 4) — REST routes mounted BEFORE global error handler ──
// Disabled means no /admin/agent routes at all (never stubs), the same doctrine as
// the payments and notifications modules above.
if (config.aiAgent && config.aiAgent.enabled) {
  try {
    app.use('/admin/agent', require('./src/routes/agentRoutes'));
    console.log('[INFO] Agent REST mounted: /admin/agent');
  } catch (err) {
    console.warn('[WARN] Agent router failed to mount:', err.message);
  }
} else {
  // WHY: with the flag off the admin console's agent panel gets a bare 404 and
  // nothing on the server says why — which is indistinguishable from "the feature
  // broke". One boot line names the cause instead of leaving it to a client error.
  // The no-stub doctrine is unchanged: nothing is mounted in this branch.
  console.log('[INFO] AI admin agent disabled (AI_AGENT_ENABLED=false) — /admin/agent and /agent-ws are not mounted.');
}

// ── Bunny Stream routes ────────────────────────────────────────────────────────
// /courses prefix: handles POST /courses/:courseId/videos (create)
// /videos prefix:  handles POST /videos/:videoId/upload and GET /videos/:videoId/playback
// These are additive — no conflict with existing /courses or /videos routes.
app.use('/courses', bunnyVideoRoutes);
app.use('/videos', bunnyVideoRoutes);

app.get('/', (req, res) => {
    res.send('Hello World!');
});

// ── Global error handler (must be last, after all routes) ─────────────────────
// Catches errors thrown by Bunny video routes via next(err).
// Uses the repo's existing { success, error } response envelope.
// Does NOT affect existing routes that use ad-hoc res.status().json() handling.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    // Report server-side AppErrors to Sentry (those with a 5xx status —
    // 4xx are expected client errors and are noise in an error tracker).
    if (err.statusCode >= 500) {
      captureException(err, req);
    }
    return res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code,
    });
  }

  // Fail-closed rate limiting: REQUIRE_REDIS_RATE_LIMIT=true + a dead Redis
  // store → the limiter rethrows RateLimitStoreUnavailableError. Serve 503 so
  // clients retry instead of getting an unthrottled pass-through or a 500.
  if (err && err.code === 'RATE_LIMIT_STORE_UNAVAILABLE') {
    captureException(err, req);
    const statusCode = err.statusCode || 503;
    return res.status(statusCode).json({
      success: false,
      error: 'Rate limiting is temporarily unavailable. Please try again shortly.',
      code: err.code,
    });
  }

  // Report unexpected errors to Sentry (never log the err object directly —
  // it may contain secrets).
  captureException(err, req);
  console.error('[ERROR] Unhandled error:', err.message || 'Unknown error', {
    path: req.path,
    method: req.method,
  });

  return res.status(500).json({
    success: false,
    error: 'An internal server error occurred.',
  });
});

// ── Process-level crash handlers ─────────────────────────────────────────────
// An uncaught exception / unhandled rejection that slips past route-level
// try/catch must not leave the process half-alive serving stale state — log it,
// flush the Sentry crash report (non-blocking), then exit so the platform
// (Railway) restarts us cleanly. Railway restarts on exit; systemd/docker
// restart policies handle it elsewhere.
process.on('uncaughtException', (err) => {
  captureException(err);
  console.error('[FATAL] uncaughtException:', err);
  // Give Sentry a moment to flush the crash event before the process dies —
  // otherwise the just-captured report is dropped with the event loop.
  flush().finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  captureException(err);
  console.error('[FATAL] unhandledRejection:', reason);
  flush().finally(() => process.exit(1));
});

const server = app.listen(port, () => {
    console.log(`Example app listening at http://localhost:${port}`);
    console.log('CORS enabled for configured origins');

    // The agent's WebSocket needs the listening HTTP server, so it is attached
    // here rather than at require time: unit tests that import app.js without
    // listening never create a socket server (or its timers) by accident.
    if (config.aiAgent && config.aiAgent.enabled) {
      try {
        const { initAgentSocket, SOCKET_PATH } = require('./src/services/agent/socketHandler');
        initAgentSocket(server);
        console.log(`[INFO] Agent WebSocket mounted at ${SOCKET_PATH}`);
      } catch (err) {
        console.warn('[WARN] Agent WebSocket failed to mount:', err.message);
      }
    } else {
      // Same reason as the REST mount above: a silently absent /agent-ws looks like
      // a broken client, so the boot log states it was configuration, not failure.
      console.log('[INFO] AI admin agent disabled (AI_AGENT_ENABLED=false) — /agent-ws is not mounted.');
    }

    // Start Bunny video reconciliation job (every 10 minutes). Keep the task
    // handle so shutdown can stop it.
    reconciliationTask = startReconciliationJob();

    // Phase 8: soft-delete purge (daily 04:17). Deliberately OUTSIDE the
    // `config.aiAgent.enabled` block below — soft delete is core platform
    // behaviour, not an agent feature, so it must run with the agent switched off.
    // Ships with dry-run ON by default (SOFT_DELETE_PURGE_DRY_RUN), so the first
    // runs log what they would remove and destroy nothing.
    try {
      const { startSoftDeletePurgeJob } = require('./src/jobs/pruneSoftDeleted');
      softDeletePurgeTask = startSoftDeletePurgeJob();
    } catch (err) {
      // Retention slipping a day is survivable; boot is not.
      console.warn('[WARN] Soft-delete purge job failed to start:', err.message);
    }

    // Agent conversation retention (daily). Deletes transcripts untouched for
    // longer than AI_AGENT_CONVERSATION_RETENTION_DAYS, with messages and
    // approvals cascading. Only meaningful when the agent is enabled.
    if (config.aiAgent && config.aiAgent.enabled) {
      try {
        const { startRetentionJob } = require('./src/jobs/pruneAgentConversations');
        agentRetentionTask = startRetentionJob();
      } catch (err) {
        // Retention slipping a day is survivable; boot is not.
        console.warn('[WARN] Agent retention job failed to start:', err.message);
      }
      // Agent memory retention (Phase 7, Decisions #21–22): the twin of the
      // conversation sweeper — same fail-open shape, its own 03:47 tick and lock,
      // the same "enabled means memories exist" gate.
      try {
        const { startMemoryRetentionJob } = require('./src/jobs/pruneAgentMemories');
        agentMemoryRetentionTask = startMemoryRetentionJob();
      } catch (err) {
        // Same doctrine as its twin: a slipping window is survivable, boot is not.
        console.warn('[WARN] Agent memory retention job failed to start:', err.message);
      }
    }

    // Payments reconciliation (D11 backstop) — only when the module is enabled.
    // Lazy require + guarded start: a payments problem must never break boot.
    if (config.features && config.features.payments && config.paymob && config.paymob.enabled) {
      try {
        const { startPaymentReconciliationJob } = require('./src/jobs/reconcilePayments');
        paymentReconciliationTask = startPaymentReconciliationJob();
        console.log('[INFO] payment.reconcile.job_started', JSON.stringify({ schedule: 'every 10 minutes' }));
      } catch (err) {
        console.warn('[WARN] Payment reconciliation job failed to start:', err.message);
      }
    }

    // Crash recovery: uploads interrupted by a previous shutdown can never
    // resume (their process is gone) — mark them FAILED so re-upload works.
    // Best-effort and boot-non-blocking: a DB outage here must not kill boot.
    try {
      const { recoverInterruptedUploads } = require('./src/services/bunnyVideoService');
      recoverInterruptedUploads()
        .then((count) => { if (count > 0) console.log(`[INFO] Recovered ${count} interrupted upload(s) to FAILED`); })
        .catch((err) => console.warn('[WARN] Upload crash recovery failed:', err.message));
    } catch (err) {
      console.warn('[WARN] Upload crash recovery failed:', err.message);
    }

    // Start AI essay-grading worker (in-process BullMQ). No-ops with a warning
    // when GEMINI_API_KEY is missing or Redis is disabled — human grading path
    // is unaffected.
    // Multi-instance: set AI_WORKER_PROCESS=true (and run scripts/ai-grader-worker.js
    // on a dedicated instance) to keep grading off the API processes.
    if (String(process.env.AI_WORKER_PROCESS || '').toLowerCase() !== 'true') {
      try {
        const { startAiGradingWorker } = require('./src/services/aiGrader/worker');
        startAiGradingWorker();
      } catch (err) {
        console.warn('[WARN] AI grading worker failed to start:', err.message);
      }
    } else {
      console.log('[INFO] AI_WORKER_PROCESS=true — AI grading worker running standalone; API will not start an in-process worker.');
    }
});

// ── Graceful shutdown (SIGTERM/SIGINT) ──────────────────────────────────────
// Closes the HTTP server, then drains Prisma + Redis so queued writes finish
// instead of the platform SIGKILL-ing mid-transaction. Force-exit after 10s
// so a hung connection can't keep the instance "up" after detach.
let reconciliationTask = null; // node-cron task handle (stopped on shutdown)
let paymentReconciliationTask = null; // payments cron handle (only when enabled)
let agentRetentionTask = null; // agent transcript retention cron handle
let agentMemoryRetentionTask = null; // agent memory retention cron handle (Phase 7)
let softDeletePurgeTask = null; // soft-delete purge cron handle (Phase 8)

function shutdown(signal) {
  console.log(`[SHUTDOWN] ${signal} received — draining connections...`);

  // Stop the reconciliation cron so a tick can't fire mid-drain.
  try {
    require('./src/jobs/reconcileStaleVideos').stopReconciliationJob(reconciliationTask);
    reconciliationTask = null;
  } catch (err) {
    console.warn('[WARN] Reconciliation cron stop failed:', err.message);
  }

  // Payments cron is only present when the module was enabled at boot.
  try {
    if (paymentReconciliationTask) {
      require('./src/jobs/reconcilePayments').stopPaymentReconciliationJob(paymentReconciliationTask);
      paymentReconciliationTask = null;
    }
  } catch (err) {
    console.warn('[WARN] Payment reconciliation cron stop failed:', err.message);
  }

  // Agent retention cron — same: absent when the agent was disabled at boot.
  try {
    if (agentRetentionTask) {
      require('./src/jobs/pruneAgentConversations').stopRetentionJob(agentRetentionTask);
      agentRetentionTask = null;
    }
  } catch (err) {
    console.warn('[WARN] Agent retention cron stop failed:', err.message);
  }

  // Agent memory retention cron (Phase 7) — its own handle and its own stop, so a
  // failure in one sweeper's teardown cannot leave the other cron firing mid-drain.
  try {
    if (agentMemoryRetentionTask) {
      require('./src/jobs/pruneAgentMemories').stopMemoryRetentionJob(agentMemoryRetentionTask);
      agentMemoryRetentionTask = null;
    }
  } catch (err) {
    console.warn('[WARN] Agent memory retention cron stop failed:', err.message);
  }

  // Soft-delete purge cron (Phase 8) — its own handle and its own stop. A
  // destructive sweep must never be able to fire mid-drain.
  try {
    if (softDeletePurgeTask) {
      require('./src/jobs/pruneSoftDeleted').stopSoftDeletePurgeJob(softDeletePurgeTask);
      softDeletePurgeTask = null;
    }
  } catch (err) {
    console.warn('[WARN] Soft-delete purge cron stop failed:', err.message);
  }

  // Close BullMQ worker + queue so their dedicated Redis connections are
  // released before the shared client below. Guarded: modules self-exist only
  // when started (Redis/AI key present).
  const bullMqClosers = [];
  try {
    const worker = require('./src/services/aiGrader/worker');
    if (worker && worker.stopAiGradingWorker) {
      bullMqClosers.push(worker.stopAiGradingWorker());
    }
  } catch (err) {
    console.warn('[WARN] AI worker stop failed:', err.message);
  }
  try {
    const queue = require('./src/services/aiGrader/queue');
    if (queue && queue.closeGradingQueue) {
      bullMqClosers.push(queue.closeGradingQueue());
    }
  } catch (err) {
    console.warn('[WARN] AI queue stop failed:', err.message);
  }

  server.close(async () => {
    try {
      await Promise.allSettled(bullMqClosers);
    } catch (err) {
      console.warn('[WARN] BullMQ shutdown failed:', err.message);
    }
    try {
      const prisma = require('./src/config/db');
      await prisma.$disconnect();
    } catch (err) {
      console.warn('[WARN] Prisma disconnect failed:', err.message);
    }
    try {
      const { disconnectRedis } = require('./src/integrations/redis/redisClient');
      await disconnectRedis();
    } catch (err) {
      console.warn('[WARN] Redis disconnect failed:', err.message);
    }
    console.log('[SHUTDOWN] clean exit');
    process.exit(0);
  });
  // Force-exit if connections refuse to drain (keeps Railway's healthcheck honest).
  setTimeout(() => {
    console.error('[SHUTDOWN] drain timeout — forcing exit');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app; // Export for testing