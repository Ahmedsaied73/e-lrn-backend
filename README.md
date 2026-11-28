# E-Learning Platform (Backend API)

Express + Prisma + PostgreSQL (`pgvector/pgvector:pg16`) + Redis 7 backend for Egyptian secondary school (ثانوية عامة) e-learning. Supports Bunny.net Stream video hosting, SurveyJS quizzes with Rich Math/Chemistry answers, AI essay grading, `صور حلك` handwritten photo extraction, sequential unlock gates, Paymob course payments, access codes, notifications, and a confirmation-gated AI Admin Agent.

**Port**: `3005` (Monolith, `APP_MODE=api`, or `APP_MODE=worker`)

## Core & Optional Features

- **Cookie-Only JWT Auth**: HttpOnly `accessToken` (15m) + rotating `refreshToken` (7d, `jti` + family revocation) with `COOKIE_SAMESITE=lax` for same-site subdomains (`teacherdomain.com` + `api.teacherdomain.com`).
- **Authoritative Admin Checks**: DB-verified `isAdmin(req)` (`deletedAt: null`) with `invalidateRoleCache(userId)` on delete/demotion across all admin and student-path gates.
- **Bunny.net Stream Video Pipeline**: Binary upload via Busboy, HMAC-SHA256 webhooks, signed embed playback tokens (clamped to `enrollment.expiresAt`), and 10-minute reconciliation of stuck uploads.
- **SurveyJS Quizzes & Rich Answers**: Auto-graded MCQs, essay grading (human + BullMQ/Gemini AI Grader with 5-minute reconciler & daily token budget), time limits, `maxAttempts` (default 3), and server-side KaTeX/`mhchem` validation.
- **Paymob Payments (`PAYMENTS_ENABLED`)**: Whole-EGP integer pricing, 365-day access windows (`enrollment.expiresAt`), `checkEnrollmentAccess()` enforced on playback, quiz meta/start/attempts/submit, and expiry-aware gate caching.
- **Essay Photo (`صور حلك`)**: Gemini-powered handwriting-to-LaTeX extraction (`ESSAY_PHOTO_ENABLED`), enabled per teacher (`essayPhotoEnabled`).
- **AI Admin Agent (`AI_AGENT_ENABLED`)**: Read tools + 100% confirmation-gated write tools (`confirmableActionTool` / `KIND_CONFIRM`, including `upsert_quiz` validation preview and `remember_fact`/`forget_fact`), REST `/admin/agent/*` + WebSocket `/agent-ws`.
- **Observability & Probes**: `/healthz` (liveness), `/readyz` (verifies `_prisma_migrations` + active `ADMIN`), `/metrics` (Bearer `METRICS_TOKEN` or DB-verified admin; exports `http_requests_total`, `http_request_duration_seconds`, `bullmq_jobs_failed_total`), and PII-redacted structured request logging.

## Getting Started

### Prerequisites

- Node.js 24+
- PostgreSQL 16 (`pgvector/pgvector:pg16` recommended) & Redis 7

### Installation & Setup

```bash
npm install
cp .env.example .env
npm run db:setup        # prisma migrate deploy && prisma generate
npm run dev             # nodemon (watches app.js)
```

### Key Environment Variables (`src/config/env.js`)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` / `DIRECT_URL` | PostgreSQL connection strings (local Docker or Supabase pooler) |
| `FRONTEND_URL` | Explicit allowed CORS origin(s) (wildcards rejected in production) |
| `JWTSECRET` / `REFRESH_TOKEN_SECRET` | Dedicated signing secrets (placeholders rejected in production) |
| `COOKIE_DOMAIN` / `COOKIE_SAMESITE` | Cookie scope (`.teacherdomain.com` / `lax` for same-site launch) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Auto-seeded admin (`>=12` chars, placeholders rejected in production) |
| `BUNNY_STREAM_LIBRARY_ID` | Numeric Bunny library ID |
| `BUNNY_STREAM_API_KEY` | Full-access Bunny API key |
| `BUNNY_STREAM_READ_ONLY_API_KEY` | Read-only key & webhook HMAC secret |
| `BUNNY_STREAM_TOKEN_KEY` | Embed playback token signing key |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Supabase Storage for quiz/course images |
| `REDIS_ENABLED` / `REDIS_URL` | Redis cache, rate limiting, and BullMQ queues |
| `GEMINI_API_KEY` | AI Grader, Essay Photo (`صور حلك`), and Admin Agent |
| `AI_STUDENT_SUBJECT` | Deployment subject (`MATH`, `PHYSICS`, `CHEMISTRY`, `ARABIC`, etc.) |
| `PAYMENTS_ENABLED` / `PAYMOB_*` | Paymob one-time course checkout & webhooks |
| `METRICS_TOKEN` | Bearer token for Prometheus `/metrics` scraping |

## Testing & CI

- `npm run lint` — ESLint 9 check
- `npx prisma validate` — Prisma schema validation
- `npm test` — `node:test` integration/unit suite (CI runs against ephemeral `pgvector/pgvector:pg16` + `redis:7-alpine` seeded by `scripts/seedTestDb.js`)

## Deployment & Docs

- **Production VPS Guide:** [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md) (`deploy/docker-compose.yml` + `deploy/monitoring/docker-compose.monitoring.yml`)
- **Runbooks:** [`docs/runbooks/`](docs/runbooks/) (`add-tenant.md`, `deploy.md`, `rollback.md`, `restore.md`, `rotate-secrets.md`, `incident.md`)
- **Post-Launch RAG Blueprint:** [`docs/RAG_CONNECT_GUIDE.md`](docs/RAG_CONNECT_GUIDE.md)
- **Full API Reference:** [`API-DOCUMENTATION.md`](API-DOCUMENTATION.md)

## License

MIT — see `LICENSE`.
