# Todo — Hardening Batch 1 (audit tail)

Branch/repo note: Tasks 1–2 + 5 on `H:\e-learning-platform` (`ai-grader`);
Tasks 3–4 on `L:\E-LRN-FRONTEND\a-e-lrn-frontend` (`Dev`).

## Task 1: helmet-without-CSP (BE, S)
**Description:** Install pinned `helmet@7.x`, mount with `contentSecurityPolicy:
false`, keep all other defaults. Closes S-5 in its approved form.
**Acceptance criteria:**
- [x] `node -e "require('helmet')"` passes immediately after install
- [x] Responses carry `X-Content-Type-Options`, `X-Frame-Options`,
      `Strict-Transport-Security`, `Referrer-Policy`, no `X-Powered-By`
- [x] No `Content-Security-Policy` header emitted
- [x] Bunny iframe playback + quiz runner + fonts still load (Playwright spot)
**Verification:**
- [x] `node --check app.js`; BE boots, `/user/me` 401-anon shape unchanged
- [x] `curl -I` header dump saved as evidence
- [x] Lockfile diff reviewed (helmet has zero deps)
**Dependencies:** None
**Files likely touched:** `package.json`, `package-lock.json`, `app.js`
**Estimated scope:** Small (1–2 files + lockfile)

## Task 2: Z-1 trim attempt-list select (BE, XS)
**Description:** `listQuizAttempts` returns full rows incl. `responses`; replace
with an explicit select mirroring `listAllAttempts` (no `responses`/`answers`).
**Acceptance criteria:**
- [x] `GET /quizzes/:quizId/attempts` (admin) response contains no `responses`
      key on any item
- [x] Every field the FE grading inbox renders from the list is still present
      (FE consumer grep done first; detail endpoint untouched)
**Verification:**
- [x] `node --check src/controllers/quizController.js`
- [x] Admin list + open-attempt grading flow green in Playwright
**Dependencies:** None (FE grep is a step inside this task, not a blocker)
**Files likely touched:** `src/controllers/quizController.js`
**Estimated scope:** XS (1 file)

## Checkpoint A: BE boot + header smoke
- [x] BE boots on fresh `node app.js`, admin auto-setup line present in log
- [x] Anon `/user/me` → 401 envelope unchanged; admin `/admin/dashboard` → 200
- [x] Header dump shows helmet set, no CSP
- [x] Review with human before FE tasks? (optional — FE tasks are independent)

## Task 3: /admin middleware matcher (FE, XS)
**Description:** Add `middleware.ts` redirecting cookie-less visitors away from
`/admin/:path*` (flash-of-shell fix; data still guarded by BE 403s).
**Acceptance criteria:**
- [x] Authed admin reaches `/admin` (existing layout guard still passes)
- [x] Cookie-less visitor to `/admin/grading` lands on login, no admin shell flash
- [x] Public pages (`/`, `/login`, course pages) unaffected
**Verification:**
- [x] `tsc --noEmit` clean; Playwright login + anon checks
**Dependencies:** None
**Files likely touched:** `middleware.ts` (new — check absence first)
**Estimated scope:** XS (1 file)

## Task 4: result poller SUBMITTED align (FE, XS)
**Description:** Poller condition also fires on `SUBMITTED`, matching the
displayed pending state (`isPending` already covers both).
**Acceptance criteria:**
- [x] Poller runs while status is `GRADING` or `SUBMITTED`, stops otherwise,
      same 10s/~2min bounds
**Verification:**
- [x] `tsc --noEmit` clean; result-page review of condition (SUBMITTED is
      server-dead, so live-fire is display-logic only)
**Dependencies:** None
**Files likely touched:** `app/course/[id]/video/[video]/quiz/result/[attemptId]/page.tsx`
**Estimated scope:** XS (1 file)

## Task 5: delete cache.stats() (BE, XS)
**Description:** Remove zero-caller `stats()` + `counters` from
`src/integrations/redis/cache.js` (R-3). Plan approval = deletion approval.
**Acceptance criteria:**
- [x] No `stats`/`counters` remains in `cache.js`; module exports unchanged
      otherwise; repo-wide grep shows no new breakage
**Verification:**
- [x] `node --check`; BE boot + one cached endpoint still hits cache
**Dependencies:** None
**Files likely touched:** `src/integrations/redis/cache.js`
**Estimated scope:** XS (1 file)

## Checkpoint B: complete
- [x] BE commit (Tasks 1, 2, 5) on `ai-grader`; FE commit (Tasks 3, 4) on `Dev`
- [x] Working trees clean; servers left running on the new code
- [x] Explicitly NOT in this batch: S-8/L-1, Q-5, AI-4, Docker/compose/env sync,
      dep prune, D-5, F-1, F-4, test runner
