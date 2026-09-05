# Security Round 1 — Cookie-Only Auth + CRITICAL Fixes

Status: EXECUTING | Date: 2026-09-05 | Branch: Dev (backend + frontend paired)

## Progress log

- ✅ BE auth hardening (`ea97a4c`) — env secret resolution, .env real secret, type claims, rotation, no body tokens, script cookie-auth
- ✅ FE auth pairing (`3b6a1fe`) — authService no-token, isLoggedIn from /user/me, api-client cookie-only refresh
- ✅ #3 answer-key leak (`eee12cb`)
- ✅ #4 progress precondition + structured 403 codes (`b100650`)
- ✅ FE admin guard (`44932ce`)
- ✅ FE profile assignments link removed (`dad5a86`)
- 🔶 FE course-page assignment hide (video page + course page dispatch) — UNCOMMITTED, riding in user WIP tree
- ⏳ Memory docs updated; final smoke + AGENTS.md commit pending

## Goal

Fix the CRITICAL findings from `SECURITY_AUDIT.md` (verified against code) plus the
known essay-scoring behavior decision, as a **coordinated backend ↔ frontend round**.
One commit per logical change, on each repo's `Dev` branch. No ESSAY_SCORING change.

## Grilled decisions (locked)

| Decision | Answer |
|----------|--------|
| Scope this round | CRITICALs only (auth, admin guard, answer-key leak, progress trust) |
| Auth model | **Cookie-only** — no tokens in JSON bodies; FE sets `isLoggedIn` from `/user/me` success |
| Video completion | Click-to-complete **with server unlock precondition** |
| Assignments | **FE-only hide** for now (leave backend + legacy gate check intact — legacy courses are not surfaced in the active Bunny flow) |
| Essay grading | **UNCHANGED** — admin grade required to pass; future AI-agent grader (no code now) |
| Admin sites | Being removed by user → **cheap layout role guard only** |
| Paywall | Keep free (documented) |
| Assignment FE edits | Minimal surgical edits on WIP files (course pages + slice + service wiring) |
| Execution order | Go chronological after plan sealed |

## Verified verdict (from audit)

**OPEN (fixing this round):**
- #1 `REFRESH_TOKEN_SECRET` is a placeholder; refresh tokens signed with `JWTSECRET`; no `type` claims; no rotation on refresh
- #2 FE admin routes have zero auth/role check (backend admin APIs ARE protected)
- #3 `getAssignment` returns `correctOption`/`explanation` to students pre-submit
- #4 `POST /progress/complete` trusts client (no unlock precondition)
- #7 No CSP/security headers on frontend (defer — HIGH, not CRITICAL)
- #9 `/courses/enrolled` shape mismatch (`data:[{id:enrollmentId, createdAt, course}]`) (defer)
- #10 Gate 403 brittle — no structured `code` (fixing structurally)
- #11 Assignments BunnyVideo-id vs legacy Video cross-stack (resolved by FE-only remove of assignment UI)

**BY DESIGN:** #5 payment auto-paid (keep free).
**NOT AN ISSUE:** #8 quiz result IDOR (ownership check at quizController.js:298).
**MITIGATED:** #12 quiz timer server-side EXPIRED (quizService.js:446-457).
**KNOWN:** essay score% uses `mcqEarned/(mcq+essay)` — accepted until AI grader.

## Execution order (one commit each)

### Backend

1. **Auth hardening** (BE)
   - `src/config/env.js`: refresh-secret resolution — reject placeholder in production (exit), warn+fallback to `JWTSECRET` in dev; expose `jwt.secret` / `jwt.refreshSecret`.
   - `.env` (untracked): set real `REFRESH_TOKEN_SECRET` (generated).
   - `.env.example`: document requirement (placeholder must be replaced).
   - `src/utils.js`: `createToken` adds `{ type: 'access' }`; `createRefreshToken` adds `{ type: 'refresh' }` (7d default).
   - `src/controllers/authController.js`: use config secrets; refresh verifies with refreshSecret + `type:'refresh'` + DB match; **rotation** (new refresh → DB + cookie); **no `token`/`refreshToken` in response bodies** (login/register keep `data.user`).
   - `src/middlewares/index.js`: verify with config access secret; reject `type !== 'access'`.

2. **#3 answer-key leak** — `assignmentController.getAssignment`: students pre-submit get `{ id, text, options, points }` only; full payload (correctOption/explanation/userAnswer) only after submission or for admins.

3. **#4 progress trust + structural codes**
   - `videoProgressController.markVideoCompleted`: accept only when the video is the current unlocked index in the course (first video, or previous completed), else 403.
   - Add `code` to 403 shapes: `NOT_ENROLLED` / `SEQUENTIAL_GATE` / `VIDEO_NOT_UNLOCKED` (sequentialAccess.js + bunnySequentialAccess.js + markVideoCompleted).

### Frontend (paired)

4. **Auth pairing** — `services/authService.ts` stops reading `data.token`/`data.refreshToken`; sets `isLoggedIn` cookie after successful auth + `getCurrentUser`; `lib/api-client.ts` refresh stays cookie-based (no body-token dependency).
5. **Admin guard** — `app/admin/layout.tsx` server-side role check via `/user/me`, redirect non-ADMIN.
6. **Assignment hide** — minimal surgical removal of assignment JSX + slice/service wiring from `app/course/[id]/*` pages; preserve all uncommitted WIP in those files.

## Review / Verify gates

- After each BE change: `node --check <file>`.
- After FE change: `npx tsc --noEmit`.
- Full `git diff` review before each commit; commit only on `Dev`, one commit per change.
- Manual smoke: `node app.js` boots; login returns no tokens; refresh rotates; gate 403 carries `code`.
- Update `AGENTS.md` bug table + this file status at the end.

## Explicitly out of scope this round

- Essay scoring change (user decision), CSP/security headers (#7), legacy-enrolled shape (#9), paywall, Bunny/webhook work, admin API surface.