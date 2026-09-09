require('dotenv').config();

// [C-3] Fail fast — refuse to start if critical secrets are missing
if (!process.env.JWTSECRET) {
  console.error('[FATAL] JWTSECRET environment variable is not set. Server will not start.');
  process.exit(1);
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

const config = {
  jwt: {
    secret: process.env.JWTSECRET,
    expiry: process.env.JWT_EXPIRY || '1h',
    refreshSecret: resolveRefreshSecret(),
    refreshExpiry: process.env.REFRESH_TOKEN_EXPIRY || '7d'
  },
  supabase: resolveSupabase(),
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