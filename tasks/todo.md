# Todo — run-to-zero (remaining audit tail)

Repo: `H:\e-learning-platform` (`ai-grader`) unless marked FE (`Dev`).
Do NOT start parked items (P-A…P-D) without explicit user order.

## R1: Docker/env repair (S)
**Description:** Fix `Dockerfile` CMD (no `npm start` script — use `node
app.js`), sync compose vars with real names, add PORT/EMAIL_* to
`.env.example`, remove stale YOUTUBE key (or keep with a note — decide in task).
**Acceptance criteria:**
- [x] `docker build` parses; compose boots to fail-fast-or-healthy (no instant env crash)
- [x] `.env.example` documents every key read in `src/config/env.js`
**Verification:** [ ] Build dry-run; [ ] `node -e` env-load check; [ ] diff review
**Dependencies:** None
**Files likely touched:** `Dockerfile`, `docker-compose.yml`, `.env.example`
**Estimated scope:** Small (3 files)

## R2: AI-4 budget counts retries (XS)
**Description:** Budget `incr` once per job but `gradeEssay` retries ×2 (up to 3
calls). Count attempts (incr per try) or document the undercount + keep
fail-open explicitly.
**Acceptance criteria:**
- [x] Budget reflects worst-case calls, or code comment records the accepted gap
**Verification:** [ ] `node --check`; [ ] mock-provider budget-trip test green
**Dependencies:** None
**Files likely touched:** `src/services/aiGrader/worker.js` and/or `index.js`
**Estimated scope:** XS (1–2 files)

## R3: dep prune + audit triage (M)
**Description:** Remove unused `axios`, `nodemailer`, bare `langchain` (only
`@langchain/google-genai` imported); triage remaining audit hits (jws,
qs/body-parser/express chain, form-data/tar) one dep per change with changelog.
**Acceptance criteria:**
- [ ] `npm ls axios nodemailer langchain` empty; boot + matrix green
- [ ] Each upgrade isolated, lockfile diff reviewed, no `--force`
**Verification:** [ ] `npm audit` delta recorded; [ ] boot; [ ] p2-verify green
**Dependencies:** User confirms deletions (grill Q3)
**Files likely touched:** `package.json`, `package-lock.json`
**Estimated scope:** Medium (supply-chain care, not line count)

## R4: D-5 assignment indexes (S)
**Description:** Add missing single-column indexes on assignment tables
(Assignment.videoId, AssignmentQuestion.assignmentId, Submission
assignmentId/userId, AssignmentAnswer.questionId) via migration.
**Acceptance criteria:**
- [ ] Migration applies clean; `EXPLAIN` shows index use on the tied queries
**Verification:** [ ] `migrate status`; [ ] assignment submit/grade smoke
**Dependencies:** None
**Files likely touched:** `prisma/schema.prisma`, `prisma/migrations/*`
**Estimated scope:** Small (schema + migration)

## R5: notify trigger warn logs (XS)
**Description:** `catch{}` on notify trigger paths swallows outages silently —
add warn-level log, keep swallowing (failure-isolation stays).
**Acceptance criteria:**
- [ ] Every trigger catch logs warn with context; no throw added
**Verification:** [ ] `node --check`; [ ] notifications verify script green
**Dependencies:** None
**Files likely touched:** `src/services/notifications/*`, call sites
**Estimated scope:** XS (2–3 files)

## R6: F-1 autosave queue (FE, S)
**Description:** `useQuizAutosave` drops edits made mid-save until next 25s
tick — queue one trailing save behind the in-flight promise instead of
returning it.
**Acceptance criteria:**
- [ ] Edit → save-start → edit → save-end results in a second save with newest state
- [ ] Debounce + blur/hidden flush behavior unchanged
**Verification:** [ ] `tsc` clean; [ ] unit-style harness or Playwright timing test
**Dependencies:** None
**Files likely touched (FE):** `hooks/useQuizAutosave.ts`
**Estimated scope:** Small (1 file)

## R7: F-4 dead weight (FE, M)
**Description:** Import-graph proof for ThemeProvider/sonner/unused shadcn
primitives/`getCurrentUser` dup/toast bridge; then delete (or mount bridge per
user product call).
**Acceptance criteria:**
- [ ] Proof committed as evidence; only proven-unused code removed
- [ ] `tsc` clean; home + quiz flows green
**Verification:** [ ] Grep evidence; [ ] Playwright spot
**Dependencies:** User product call mount-vs-delete (grill Q4)
**Files likely touched (FE):** providers, shadcn ui/, services, components
**Estimated scope:** Medium (evidence-heavy, edit-light)

## R8: test runner seed (M, process)
**Description:** Adopt `node:test` (BE quiz lifecycle: start/submit/grade/
EXPIRED/gates) + `vitest` (FE result-gating render). First suites only — no
full retrofit.
**Acceptance criteria:**
- [ ] `npm test` (BE) + FE test cmd green on the seeded suites
- [ ] Suites encode the behaviors proven live in Q-5 + hide-proof runs
**Verification:** [ ] Both suites pass from clean checkout state
**Dependencies:** User confirms adoption (grill Q5)
**Files likely touched:** `package.json` scripts, `tests/*`, FE test setup
**Estimated scope:** Medium (infra + first suites)

## Checkpoint Z: complete
- [ ] Per-item commits, trees clean, servers live on new code
- [ ] p2-verify + hide-proof matrices re-run green at the end
- [ ] Parked items untouched: P-A (S-8/L-1), P-B (V-1), P-C (essay-live), P-D
