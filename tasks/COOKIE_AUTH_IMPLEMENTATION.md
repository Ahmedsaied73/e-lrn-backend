# 🛡️ Task Tracking: Cookie & CORS Authentication Implementation

## Overview & Objective
Implement dynamic CORS configuration and dual HttpOnly cookie authentication (`accessToken` + `refreshToken`) based on `COOKIE_AUTHENTICATION_GUIDE.md` while maintaining dual-mode backward compatibility for existing API clients and fixing critical route ordering & runtime bugs without breaking server architecture.

---

## Step-by-Step Execution Plan

### 1. Database Schema Update
- Add `refreshToken String? @db.Text` field to `User` model in `prisma/schema.prisma`.
- Run Prisma client generation (`prisma generate`).

### 2. Cookie Security Config Module
- Create `src/config/cookie.js` exporting environment-aware security options:
  - `accessTokenCookieOptions`: `httpOnly: true`, `secure: process.env.NODE_ENV === 'production'`, `sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax'`, `maxAge: 15 * 60 * 1000` (15m), `path: '/'`.
  - `refreshTokenCookieOptions`: `httpOnly: true`, `secure: process.env.NODE_ENV === 'production'`, `sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax'`, `maxAge: 7 * 24 * 60 * 60 * 1000` (7d), `path: '/auth'`.

### 3. Express App & CORS Configuration
- Update `app.js` to enable dynamic origin CORS checking (`allowedOrigins` including `http://localhost:3000`, `http://127.0.0.1:3000`, `process.env.FRONTEND_URL`).
- Enable `credentials: true`.
- Update `.env` and `.env.example` with `FRONTEND_URL` and `NODE_ENV`.

### 4. Auth Controller & Middleware Updates
- Update `register` & `login` in `src/controllers/authController.js` to set `accessToken` and `refreshToken` cookies on `res.cookie()` AND update user `refreshToken` in DB while maintaining payload token response (dual-mode).
- Update `logout` to clear both cookies with appropriate paths and clear DB `refreshToken`.
- Update `refreshToken` endpoint to verify `refreshToken` cookie against DB user record and issue updated `accessToken` cookie.
- Update `authenticateToken` middleware in `src/middlewares/index.js` to look for `req.cookies.accessToken` with fallback to `Authorization: Bearer` header.

### 5. Pre-existing Bug Fixes
- Reorder routes in `src/routes/assignmentRoutes.js` (move `/user/submissions`, `/video/:videoId`, `/course/:courseId` above `/:id`).
- Reorder routes in `src/routes/videoProgressRoutes.js` (move `/course/:courseId` above `/:videoId`).
- Fix `prisma.$enum.values.Grade` bug in `src/controllers/searchController.js`.
- Replace inline `new PrismaClient()` in `src/controllers/nextVideoController.js` with shared `require('../config/db')`.

---

## Task Checklist

- [x] **[Database]** Add `refreshToken` to Prisma schema (`prisma/schema.prisma`)
- [x] **[Config]** Create `src/config/cookie.js` with token cookie options
- [x] **[CORS/App]** Update `app.js` with dynamic CORS origin function & credentials support
- [x] **[Env]** Update `.env` & `.env.example` with `FRONTEND_URL` & `NODE_ENV`
- [x] **[Controller]** Update `register` & `login` in `src/controllers/authController.js`
- [x] **[Controller]** Update `logout` & `refreshToken` in `src/controllers/authController.js`
- [x] **[Middleware]** Update `authenticateToken` in `src/middlewares/index.js` to check `accessToken` cookie
- [x] **[Bug Fix]** Fix route ordering shadowing in `src/routes/assignmentRoutes.js`
- [x] **[Bug Fix]** Fix route ordering shadowing in `src/routes/videoProgressRoutes.js`
- [x] **[Bug Fix]** Fix `$enum` crash in `src/controllers/searchController.js`
- [x] **[Bug Fix]** Fix standalone `PrismaClient` in `src/controllers/nextVideoController.js`

---

## Identified Risk Areas & Mitigations

1. **Frontend Breakage / Access Control Errors**:
   - *Risk*: Disabling token in JSON response would break existing clients expecting token in response body.
   - *Mitigation*: Dual-mode support (return JSON body token + set HttpOnly cookie). Fallback to Authorization header if cookie not present.
2. **SameSite Cookie Restrictions**:
   - *Risk*: `sameSite: 'strict'` in development causes cross-port (e.g. 3000 -> 3005) cookie rejection.
   - *Mitigation*: Use `sameSite: 'lax'` during development (`process.env.NODE_ENV !== 'production'`).
3. **Route Shadowing**:
   - *Risk*: Pre-existing Express wildcard routes (`/:id`) shadowing static routes (`/user/submissions`).
   - *Mitigation*: Reorder route definitions before testing.

---

## Status: All Tasks Completed ✅
All Phase 2 implementation requirements, security standardizations, and route/runtime fixes have been fully executed.
