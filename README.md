# E-Learning Platform

Backend API for an e-learning platform built for Egyptian secondary school students. Courses contain streaming videos (Bunny.net Stream), SurveyJS quizzes, and assignments. Students progress sequentially through course content; admins manage everything.

**Stack**: Express, Postgres on Supabase (Prisma ORM), Bunny.net Stream, JWT cookies, Busboy.
**Port**: 3005

## Features

- **JWT cookie auth** — httpOnly `accessToken`/`refreshToken` cookies with refresh-token rotation
- **Role-based access** — `ADMIN` and `STUDENT` roles
- **Course management** — create, update, delete courses (per Egyptian secondary grade)
- **Bunny.net Stream video pipeline** — binary upload (streamed, no temp files), encoding status webhooks, signed embed playback, background reconciliation of stuck videos
- **Dual video systems** — modern `BunnyVideo` (quizzes + progress + sequential gate) and legacy `Video` (assignments), both supported by the sequential gate
- **Quiz system (SurveyJS)** — MCQs auto-graded at submit, essay grading by admin, time limits, max retakes (default 3), best graded score counts
- **Assignment system** — MCQ + text/file submissions for legacy videos, admin grading with feedback
- **Sequential learning** — students must finish a video (and quiz pass if present, or assignment if present) before the next unlocks; `evaluateGate()` in `src/services/quizService.js` is the single source of truth
- **Search** — courses filterable by category and grade
- **Background jobs** — 10-minute reconciliation of Bunny videos stuck in `PROCESSING`

## Getting Started

### Prerequisites

- Node.js 18+
- A Supabase project (Postgres + Storage) — see Environment variables below

### Installation

```bash
npm install
cp .env.example .env
```

Fill in the `.env` file (see below). This project uses **CommonJS** and **dotenv**.

### Run database migrations

```bash
npm run db:setup
```

Equivalent to `prisma migrate deploy && prisma generate`. During development you can also use `npx prisma migrate dev --name <name>` to create and apply a new migration, and `npx prisma studio` to browse the database.

### Start the server

```bash
npm run dev      # nodemon, watches app.js
```

There is **no `npm start`** script defined — use `node app.js` or `npm run dev`.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Supabase pooled Postgres connection (6543, `?pgbouncer=true`) |
| `DIRECT_URL` | Supabase direct Postgres connection (5432) for `prisma migrate` |
| `FRONTEND_URL` | Allowed CORS origin |
| `JWTSECRET` / `JWT_EXPIRY` | Access-token signing (default 1h) |
| `REFRESH_TOKEN_SECRET` / `REFRESH_TOKEN_EXPIRY` | Refresh-token signing (default 7d) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Auto-created admin on startup (via `src/config/setupAdmin.js`) |
| `BUNNY_STREAM_LIBRARY_ID` | Numeric Bunny library ID |
| `BUNNY_STREAM_API_KEY` | Full-access Bunny API key (upload/delete) |
| `BUNNY_STREAM_READ_ONLY_API_KEY` | Read-only key; also the webhook signing secret |
| `BUNNY_STREAM_TOKEN_KEY` | Bunny embed token-authentication key |
| `BUNNY_STREAM_TOKEN_TTL_SECONDS` | Playback token TTL (default 21600 = 6h) |
| `BUNNY_VIDEO_MAX_BYTES` | Max upload size (default 5GB) |

All critical env vars fail fast at startup if missing (`src/config/env.js`).

## Admin Access

The default admin is auto-created on startup from `ADMIN_EMAIL`/`ADMIN_PASSWORD`. Admins:

- Bypass the sequential video gate and enrollment checks
- Can create/manage courses, videos, quizzes, assignments, and users
- Can grant quiz-gate exemptions via `GateExemption`

## Database

Single Prisma schema at `prisma/schema.prisma` (Postgres on Supabase, `Autoincrement()` IDs). Key models:

- `User` (role ADMIN/STUDENT, grade is required — `FIRST_SECONDARY`/`SECOND_SECONDARY`/`THIRD_SECONDARY`)
- `Course` (per-grade)
- `Video` (legacy: URL reference, assignments) and `BunnyVideo` (Bunny Stream, `position` for ordering, 1:1 quiz)
- `VideoProgress` / `BunnyVideoProgress`
- `Quiz` / `QuizAttempt` (SurveyJS)
- `GateExemption`
- `Assignment` / `AssignmentQuestion` / `AssignmentAnswer` / `Submission`

To apply schema changes:

```bash
npx prisma migrate dev --name <name>
npx prisma migrate deploy    # production
npx prisma generate
```

## API

Registered route mount points in `app.js`:

- `/auth` — login, register, refresh
- `/courses` — course CRUD, `GET /courses/:id/bunny-videos`, `PUT /courses/:id/reorder`
- `/videos` — legacy video CRUD + `/stream`, Bunny upload/playback/delete
- `/quizzes` — meta, start, save, submit, result, admin upsert/grade
- `/assignments` — assignment CRUD + submissions
- `/progress` — video progress (legacy + Bunny)
- `/enrollments`, `/payments`, `/users`, `/search`
- `/webhooks/bunny/stream` — Bunny status webhook (HMAC-verified, mounted **before** `express.json()`)

Response envelope for newer endpoints: `{ success: true, data }`. Legacy endpoints return raw objects.

## Reconcile Job

`src/jobs/reconcileStaleVideos.js` polls Bunny every 10 minutes and marks videos stuck in `PROCESSING` longer than 30 minutes as `FAILED` so they can be re-uploaded.

## Scripts

- `npm run upload:course` — `node scripts/uploadCourseFolder.js`
- `scripts/markEnrollmentAsPaid.js`, `scripts/enrollAdminsInAllCourses.js`, `scripts/checkDbTables.js`, `scripts/testQuizFlow.js`, `scripts/testQuizLogic.js`, `scripts/uploadDemoVideos.js`, `scripts/testBunnyIntegration.js`

## Key Conventions

- **CommonJS** modules (`require`/`module.exports`)
- **Error handling** — Bunny service layer throws `AppError` (`src/utils/AppError.js`) → global handler returns `{ success: false, error, code }`; quiz service uses ad-hoc errors with `statusCode`; legacy routes use raw `res.status().json()`
- **Bunny HTTP calls** go only through `src/integrations/bunny/bunnyStreamClient.js`
- **Sequential gate** — `quizService.evaluateGate()` is the single source of truth, works for both `Video` and `BunnyVideo`
- **Payments disabled** — enrollments auto-mark as paid; the payment controller returns 403 in production

## License

This project is licensed under the MIT License — see the LICENSE file for details.