const express = require('express');
const cors = require('cors'); // Import CORS package
const cookieParser = require('cookie-parser'); // Import cookie-parser package
const Authrouter = require('./src/routes/auth');
const Userrouter = require('./src/routes/users');
const Courserouter = require('./src/routes/courses');
const SearchRouter = require('./src/routes/searchRoutes');
const PaymentRouter = require('./src/routes/paymentRoutes');
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

// S-5: security headers. CSP was previously OFF ("needs FE coordination") —
// now locked to our real asset origins. The backend is a JSON API, so the
// script/style directives are tight; connect-src permits the FE (Vercel) +
// Supabase + Bunny CDN the browser talks to when proxying through this API.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      fontSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://*.b-cdn.net', 'https://*.supabase.co'],
      frameAncestors: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
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

// ── Health check (mounted BEFORE the rate limiter — probes must never be
//     throttled, and this doubles as Railway's `/health` healthcheck path).
//     Errors are logged by the process-level handlers; the route itself stays
//     silent to keep health probes quiet in the request logs.
app.get('/health', async (req, res) => {
  const started = Date.now();
  try {
    const prisma = require('./src/config/db');
    // Live DB ping — a 200 without this only proves the process is up, not
    // that it can serve requests (the pool collapsing is exactly what killed
    // it under load in the DB-audit incident).
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('db ping timeout')), 3000)),
    ]);
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
app.use('/payments', PaymentRouter);
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
    const statusCode = err.statusCode || 503;
    return res.status(statusCode).json({
      success: false,
      error: 'Rate limiting is temporarily unavailable. Please try again shortly.',
      code: err.code,
    });
  }

  // Log unexpected errors (never log the err object directly — it may contain secrets)
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
// then exit so the platform (Railway) restarts us cleanly. Railway restarts on
// exit; systemd/docker restart policies handle it elsewhere.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
  process.exit(1);
});

const server = app.listen(port, () => {
    console.log(`Example app listening at http://localhost:${port}`);
    console.log('CORS enabled for configured origins');

    // Start Bunny video reconciliation job (every 10 minutes). Keep the task
    // handle so shutdown can stop it.
    reconciliationTask = startReconciliationJob();

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

function shutdown(signal) {
  console.log(`[SHUTDOWN] ${signal} received — draining connections...`);

  // Stop the reconciliation cron so a tick can't fire mid-drain.
  try {
    require('./src/jobs/reconcileStaleVideos').stopReconciliationJob(reconciliationTask);
    reconciliationTask = null;
  } catch (err) {
    console.warn('[WARN] Reconciliation cron stop failed:', err.message);
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