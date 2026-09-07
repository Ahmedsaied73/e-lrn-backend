# Plan: Auth Unification + Session Guards + User Caching

Status: DRAFT (awaiting grill answers)
Repos: BE `H:\e-learning-platform` (touched only for audit) · FE `L:\E-LRN-FRONTEND\a-e-lrn-frontend`
Branches: both `Dev`. One reviewable commit per logical fix. Never touch user WIP files.

## Reported issues

1. "`authToken` in LocalStorage and `accessToken` in Cookies — why two?" 
2. Logged-in users can still open `/login` and `/register`.
3. Every page refresh/navigation refetches `/user/me` user data.

## Findings after research (what each issue actually is)

### 1. Token storage
- **No code in either repo writes `authToken` to localStorage.** The only token-ish storage is
  HttpOnly cookies (`accessToken` 15 min, `refreshToken` 7 d, path `/auth`) plus (a) a **plain,
  non-secret `isLoggedIn` cookie** used purely as a UX/guard flag, and (b) an **in-memory Bearer
  slot in `lib/api-client.ts`** (`_accessToken`) that is **never populated** — a dead compat shim
  (`setAccessToken` has zero call sites; the `Authorization: Bearer` header is never attached).
- So the duplicate scheme the user sees is most likely a **stale localStorage key from an old
  build** (the codebase *removes* legacy keys `refreshToken`/`userData` on logout but nothing
  proactively purges them, and no `authToken` key is even in the removal list).
- The already-"most secure" mechanism is the HttpOnly cookie flow. "Unify" = **delete the dead
  Bearer shim + its `authenticated` option** so there is exactly ONE auth channel, and
  **proactively purge every legacy token-ish localStorage key** on boot/login/logout.

### 2. Session guard for auth pages
- `/login` and `/register` have **no mount-time check**; an authenticated user can open them.
- Register flow is also inconsistent: backend opens a session on register (`/user/me` confirms it)
  but the page **never dispatches `loginSuccess`** and then **redirects to `/login`** — i.e. the
  new user is bounced to a login form for a session they already have.

### 3. `/user/me` caching
- The user object lives in Redux (`authSlice`), hydrated exactly **once per app session** by
  `AuthInitializer` (`store/auth-initializer.tsx:49`). A **full page refresh starts a new app
  session** → fires `/user/me` again. No SWR/react-query/zustand installed; Redux only.
- Fix: client-side profile cache (localStorage) with a TTL so a refresh within TTL hydrates from
  cache with **zero** requests; `/user/me` fires only when the cache is absent/expired.

## Tasks

### Task A — Unify auth on the single (HttpOnly cookie) mechanism
- A1 `lib/api-client.ts`: remove `_accessToken`/`setAccessToken`/`getAccessToken`/
  `clearAccessToken`, the `RequestOptions.authenticated` option, and the Bearer header branch in
  `buildHeaders`. Update all call sites (authService `authenticated:false` x2, utils/auth-utils).
- A2 New `purgeLegacyAuthStorage()` (utils/auth-utils.ts): remove legacy token-ish keys
  (`authToken`, `refreshToken`, `userData`, `token`, `userId`, `userName`, `userEmail`,
  `userRole`, `isLoggedIn`) once, so no stale secret-holding key can survive an old build. Call on
  AuthInitializer boot, `logoutUser`, and the final-401 handler.
- A3 Cookie/CORS audit (BE `src/config/cookie.js`, `app.js` CORS): confirm CSRF posture; adjust
  only if deployment topology forces cross-site (see grill Q3).

### Task B — Guard `/login` & `/register`; fix register redirect
- B1 Both pages: once Redux `auth.initialized` is true and `isAuthenticated`, `router.replace('/')`.
- B2 Register page: dispatch `loginSuccess(await registerUser(...).user)`, redirect home.
- B3 Update success toast text.

### Task C — Cache current user; `me` on-demand
- C1 New `lib/user-cache.ts`: `{ user, expiresAt }` under `elrn:user-cache`, TTL 5 min,
  corruption-safe read (miss on parse failure), `getCachedUser`/`setCachedUser`/`clearUserCache`.
- C2 `AuthInitializer`: cookie present + fresh cache → hydrate instantly (no request); else fetch
  `/user/me` and write cache; on failure clear cache + loginFailure.
- C3 Write cache after login/register success; clear on logout and final-401.
- C4 (optional) `storage` event listener to drop cache when another tab logs out.

### Task D — IDOR / XSS / CSRF audit (scoped) + fix findings
- D1 Backend: sweep user-scoped endpoints for missing ownership scoping (quiz attempts,
  assignment get/submit, progress, enrollments, achievements).
- D2 FE XSS: already swept — `chart.tsx` injects static CSS only; `QuizRunner` sanitizes survey
  HTML before `innerHTML`; no other dangerous sinks. Report status in final commit.
- D3 CSRF: document cookie `sameSite lax/strict` + CORS allowlist posture; change only per Q3.

### Verification
- `tsc --noEmit` clean on FE.
- Playwright: (1) login → only HttpOnly cookies + `isLoggedIn` flag, no token localStorage keys;
  (2) hard refresh within TTL → 0 `/user/me` requests; (3) logged-in user opening `/login` and
  `/register` → bounced to `/`; (4) fresh register → lands on `/` logged-in (no intermediate
  login); (5) logout purges legacy keys.

## Grill decisions (locked)

1. **authToken**: stale legacy junk → purge all legacy token keys on boot/login/logout + delete the
   dead in-memory Bearer shim. HttpOnly cookies are the single auth channel.
2. **User cache**: localStorage, **5-min TTL**, profile PII only (no session tokens), corruption-safe
   read. Cross-tab: clear cache on `storage` event keyed to the cache key (logout in one tab can't
   leave a stale profile in another).
3. **Topology**: NOT deployed yet → keep `sameSite: lax` (dev) / `strict` (prod) + HttpOnly as-is;
   revisit cookie policy at deploy time. No cookie/CORS change in this round.
4. **Register**: auto-login + go home (hydrate Redux via `/user/me`, `router.replace('/')`). No more
   bounce to `/login` for a session that already exists.
5. **IDOR/authorization**: **full backend sweep**, planned as its own phase (Task D) with a
   controller×ownership matrix, read-only audit first, findings classified as fix-now vs
   escalate-to-user (behavioral/ownership ambiguity) — **nothing conflicting is edited without
   returning to the user**. After all changes: verify app does not crash, FE `tsc`, BE boot+smoke,
   Playwright FE checks, and fix every side effect.
6. **Commits**: this round = 2 FE commits (A: unify+purge; B+C: guards + register + cache) then
   Task D findings each fix in its own commit. Update `frontend-handoff.md`.

## Task D — Full backend authorization/IDOR sweep (planned, read-only first)

Method:
1. Inventory every route mount in `app.js` + each `src/routes/*` file: path, HTTP method, middleware
   stack (`authenticateToken`, `authorizeAdmin`, role + sequential gates), and the controller it
   maps to.
2. For each controller read the ownership logic: is the resource scoped to `req.user.id` (or an
   admin check) whenever a `:id` in params/body could target someone else's record? Record
   `enrollmentId`, `attemptId`, `videoId`, `courseId`, `userId` as the high-risk params.
3. Publish findings in the plan/gill: classify each as
   `FIX` (clear authorization gap — e.g. student can read/write another student's attempt) vs
   `ESCALATE` (ownership intent ambiguous, would change API behavior or break a FE contract). Do
   NOT edit `ESCALATE` items without user confirmation.
4. Fix `FIX` items, one commit each, then re-verify (API smoke per endpoint + FE tsc + Playwright
   spot checks on affected flows). Confirm at the end that no endpoint regressed and nothing crashed.

Suspicious high-value surfaces to start the inventory: quiz attempts (get/grade/submit/admin),
assignments (get/submit/grade), progress marks, enrollments (list/enroll/unenroll), achievements,
`/user` CRUD, upload/playback authz chain, admin analytics serializers (leak rule).

## Task D — Audit results (read-only, Sept 2026)

Method executed: all 11 route files + every controller + auth middleware + bunny service read.
Result: **no exploitable IDOR, missing-auth, or authorization flaw found.**

### Verified-safe (with evidence)
| Surface | Guard |
|---|---|
| Quiz attempts save/submit | ownership in BOTH controller and service: `attempt.userId !== userId → 403` (quizService.js:497, :567); result: `attempt.userId !== userId && role!=='ADMIN' → 403` (quizController); meta/start scoped to userId; `getStudentAttempts` `where:{userId,quizId}` |
| Assignments | `getAssignment` maps submissions to `req.user.id`, strips answer key pre-submit for students; submit keyed to `req.user.id` + enrollment check; grade/getSubmissions admin-guarded; specific GET routes declared before `/:id` wildcard (order-safe) |
| Enrollment | `enrollUserInCourse` derives userId from JWT (never body); status self-scoped; admin list/enroll/unenroll behind `/admin` `authorizeAdmin()` wrap |
| Payments | userId from JWT; history self-scoped; prod block in place |
| Progress | `markVideoCompleted` gated by `evaluateGate`; check + course-progress self-scoped (`where userId`) |
| Playback | route middleware `ensureBunnySequentialAccess` + service `getPlaybackAccess` re-checks enrollment off server-derived courseId (comment: "IDOR guard"), admin bypass only for ADMINS |
| Users | `updateUser` rejects `requesterId!==parsedUserId && role!=='ADMIN'`; grade/phone admin-only; `/me`, `/me/achievements` self-scoped; list/get/delete admin-guarded; `/me/*` routes declared before `/:userId` wildcard |
| Courses | `/enrolled` before `/:id` (order-safe); writes admin-guarded |
| Admin analytics | serializers exclude answerKey/answers/password/refreshToken (leak rule) |
| Admin routes | `/admin/*` router.use(`authenticateToken, authorizeAdmin()`) |

### Low-severity findings (no data breach; decide which to fix)
- **D-A `GET /courses/:id` (coursesController.js:64)**: intentionally returns course + READY-video
  metadata (titles, durations, thumbnails, ordering, teacher `id/name/email`) to ANY authenticated
  user — this is the "syllabus preview" the FE subscribe page depends on. Consistent by design, so
  NOT a bug. **Only PII question: `teacher.email`** is included — could strip email for non-admins.
- **D-B `GET /video-progress/course/:courseId` + `GET /courses/:courseId/bunny-videos`**: leak the
  SAME READY-video metadata already public via `/courses/:id` (plus `bunnyVideoId`/thumbnailUrl in
  `bunny-videos`). Redundant, self-correcting once `/courses/:id` is the single catalog source.
  Optional hardening, not required. `bunnyVideoId` is not playable without a signed token.
- **D-C `GET /assignments/:id/status` + `GET /assignments/course/:courseId`**
  (assignmentController.js:637/:724): no enrollment check → any authenticated user can enumerate
  assignment titles + due dates (assessment metadata only; submission data always self-scoped).
  Only one that is arguably more sensitive than catalog data. **Product decision needed: gate with
  enrollment check (recommended, tiny change) or leave as catalog metadata.**
- **D-D `GET /user/:userId` (userController.js:146)**: parseInt only, no safe-int guard → non-numeric
  id yields 500 instead of 400. Admin-only route; matches the already-fixed PUT/DELETE pattern.
  Trivial `FIX`.
- **D-E `POST /payment/course/:courseId` (paymentController.js:23)**: parseInt only; NaN courseId →
  500. Stub endpoint (returns 403 in prod). Trivial `FIX`.

### Recommended action set (pending user confirmation)
1. **FIX** D-D + D-E (safe-int validation → 400; zero behavioral change for valid input).
2. **FIX if approved** D-C: add the same non-admin enrollment check used by `getVideoAssignments`
   to `getAssignmentStatus` + `getCourseAssignments` (403 for non-enrolled students).
3. **Optional** D-A: strip `teacher.email` for non-admin callers (FE verify it's unused first).
4. **Skip** D-B (redundant with catalog) unless the user wants a single source of truth.
All fixes are additive/validation-only; no response-shape changes for authorized callers → no FE
change expected (will verify).