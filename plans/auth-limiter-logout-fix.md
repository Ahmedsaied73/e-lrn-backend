# Plan: auth limiter logout→login 429 (shared bucket + refresh bleed)

## Diagnosis (verified in current code, 2026-09)

**Root cause — one bucket for three endpoints.** `app.js:96-111` builds a
SINGLE `authLimiter` instance and mounts it on `/auth/login`,
`/auth/register`, AND `/auth/refresh-token`. The store key is
`rl:<ip>` regardless of backend (Redis `rateLimitStore` with fixed `PREFIX`,
or the in-memory fallback — same instance either way). Budget: **20 req /
15 min / IP shared across login + register + refresh.** Refresh traffic eats
the login budget; the next login POST gets 429.

**Bleed sources (all confirmed by reading):**
1. `api-client.ts:164-167` — EVERY 401 (any path) fires `attemptSilentRefresh`,
   including while logged out (no cookies → guaranteed fail) and including
   401s from `/auth/login` itself (wrong password costs **2**: login + refresh).
2. `doRefresh()` tries TWO endpoints sequentially; `/auth/refresh` is unmounted
   (pure 404 waste on every cycle).
3. Logged-out browsing: each page boot → `/user/me` 401 → refresh POST (fails)
   → redirect. Every boot burns 1 of the shared 20.
4. Single-flight `_pendingRefresh` is per-tab; N tabs multiply all of the above.
5. Legit rotation (1/tab/15min) also draws from the same 20.
6. Minor: login form has no double-submit guard (rapid double-click = 2 logins).

**Why logout→switch-account triggers it:** session cookies die at logout, but
the 15-min shared counter survives. Post-logout boots + a couple of retries
drain the remainder; the next account's login POST lands on 429 until window
reset. Matches the report exactly.

## Fix (surgical, no migrations, no response-shape changes)

**BE (`app.js`, `rateLimitStore.js`) — separate buckets:**
- B1: `createRateLimitStore(prefix)` accepts a namespace (default `rl:`).
- B2: three instances — `loginLimiter` (`rl:login:`, 20/15min, unchanged:
  brute-force protection stays), `registerLimiter` (`rl:register:`, 20/15min),
  `refreshLimiter` (`rl:refresh:`, **60**/15min — cookie-bound + rotated,
  abuse value low, multi-tab headroom needed). Mounted per-path.
- Budgets: login/register KEEP 20 (security posture unchanged); only refresh
  gets headroom, and refresh tokens can't mint sessions without the httpOnly
  cookie + DB match anyway.

**FE (`lib/api-client.ts`, `app/login/page.tsx`) — stop the bleed:**
- F1: skip silent refresh when logged out — no `isLoggedIn=true` cookie ⇒
  return false immediately (no POST). Login/register flows unaffected
  (they don't depend on refresh).
- F2: never refresh on `/auth/*` 401s (credential errors, not expiry).
- F3: delete the dead `/auth/refresh` fallback (always 404).
- F4: login double-submit guard (`isSubmitting` disable).
- Deferred (stated, not silently dropped): cross-tab refresh lock — per-tab
  single-flight exists; measure after separation before adding machinery.

## Verification (red → green, all net-zero)
- V0 (BEFORE fix): fire 25× `POST /auth/refresh-token` (no cookie) → 21st is
  429; then wrong-password `POST /auth/login` → **429 (bug reproduced)**.
- V1 (AFTER fix): repeat → refresh 429s from 61st; login → **401 (separated)**.
- V2: logged-out `/user/me` bursts cause **zero** `rl:refresh:*` increments
  (F1 guard; assert via Redis keys when enabled).
- V3: `npm test` green + new `tests/auth-limiter.test.js` (separation +
  refresh-guard encoding); FE `tsc`; login/logout/switch-account Playwright
  flow (logout A → login B, no 429).
- Commits: BE one (`fix(auth): separate limiter buckets + refresh headroom`),
  FE one (`fix(auth): no refresh when logged out/on auth 401s, drop dead
  fallback, login double-submit guard`).

## Risks
| Risk | Mitigation |
|---|---|
| Refresh 60 deemed too generous | Cookie+DB binding makes refresh unexploitable alone; rotation + reuse-quarantine unchanged |
| F1 skips a refresh the user needed (flag missing, cookie present) | Flag is set on every login/register alongside cookies and cleared on logout/final-401; worst case = one extra login prompt, never a lockout |
| MemoryStore restart resets counters | Pre-existing behavior, unchanged |

## Milestones (verifiable goals)
- M1: V0 reproduces 429-on-login (proves shared bucket).
- M2: BE buckets separated (V1 login→401 while refresh exhausted).
- M3: FE bleed stopped (V2 zero increments logged out).
- M4: suites + Playwright green, two commits, servers live on new code.
