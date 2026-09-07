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


// ── CRITICAL: Bunny webhook must be mounted BEFORE express.json() ─────────────
// The webhook handler needs the raw body Buffer for HMAC-SHA256 signature verification.
// express.json() would consume and parse the body before we can read it as raw bytes.
// express.raw() is scoped to this single path — it does NOT affect other routes.
app.post(
  '/webhooks/bunny/stream',
  express.raw({ type: 'application/json', limit: '2mb' }),
  handleBunnyWebhook
);

app.use(express.json());
app.use(cookieParser()); // Add cookie-parser middleware
// Add request logger middleware to log all requests
app.use(requestLogger);

// Set up rate limiter: maximum of 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});

// Stricter rate limiter for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 10 login requests per windowMs
  message: 'Too many login attempts from this IP, please try again later.'
});

// Apply rate limiter to all requests
app.use(limiter);

// Apply strict limiter to auth routes specifically
app.use('/auth/login', authLimiter);

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
});

module.exports = app; // Export for testing