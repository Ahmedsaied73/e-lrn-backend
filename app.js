const express = require('express');
const cors = require('cors'); // Import CORS package
const cookieParser = require('cookie-parser'); // Import cookie-parser package
const { performance } = require('perf_hooks');
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
const helmet = require('helmet'); // S-5: security headers WITHOUT CSP (full CSP needs FE coordination)
// Bunny Stream — new modules
const bunnyVideoRoutes = require('./src/routes/bunnyVideoRoutes');
const { handleBunnyWebhook } = require('./src/controllers/bunnyWebhookController');
const { startReconciliationJob } = require('./src/jobs/reconcileStaleVideos');
const { AppError } = require('./src/utils/AppError');

const { setupDefaultAdmin } = require('./src/config/setupAdmin');
const path = require('path');
const app = express();
const port = process.env.PORT || 3005;
const events = require('events');
events.EventEmitter.defaultMaxListeners = 15;

// Initialize default admin on startup
setupDefaultAdmin().catch(console.error);

// Define allowed frontend origins
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
    'http://127.0.0.1:3002',

  process.env.FRONTEND_URL,
].filter(Boolean);

// Configure CORS for HttpOnly cookie credential support
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error(`CORS policy does not allow access from ${origin}`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Set-Cookie'],
  maxAge: 86400
}));

// S-5: baseline security headers. CSP stays OFF — a full policy needs FE
// coordination (Bunny embed host, fonts, SurveyJS) and is explicitly deferred.
app.use(helmet({ contentSecurityPolicy: false }));


// ── CRITICAL: Bunny webhook must be mounted BEFORE express.json() ─────────────
// The webhook handler needs the raw body Buffer for HMAC-SHA256 signature verification.
// express.json() would consume and parse the body before we can read it as raw bytes.
// express.raw() is scoped to this single path — it does NOT affect other routes.
app.post(
  '/webhooks/bunny/stream',
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
// built-in MemoryStore. passOnStoreError keeps fail-open if Redis dies.
const { createRateLimitStore } = require('./src/integrations/redis/rateLimitStore');
const { isRedisEnabled } = require('./src/integrations/redis/redisClient');
const redisStoreEnabled = isRedisEnabled();
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  ...(redisStoreEnabled ? { store: createRateLimitStore(), passOnStoreError: true } : {}),
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
    ...(redisStoreEnabled ? { store: createRateLimitStore(prefix), passOnStoreError: true } : {}),
  });
}
const loginLimiter = makeAuthLimiter('rl:login:', 20);
const registerLimiter = makeAuthLimiter('rl:register:', 20);
const refreshLimiter = makeAuthLimiter('rl:refresh:', 60);

// Apply rate limiter to all requests
app.use(limiter);

// Apply strict per-endpoint limiters to auth routes (login, register, and
// refresh — refresh accepts body tokens, so it gets the same replay probing
// protection; 60/15min comfortably covers multi-tab 15-min rotation cycles).
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

app.listen(port, () => {
    console.log(`Example app listening at http://localhost:${port}`);
    console.log('CORS enabled for all origins');

    // Start Bunny video reconciliation job (every 10 minutes)
    startReconciliationJob();

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
    try {
      const { startAiGradingWorker } = require('./src/services/aiGrader/worker');
      startAiGradingWorker();
    } catch (err) {
      console.warn('[WARN] AI grading worker failed to start:', err.message);
    }
});

module.exports = app; // Export for testing