# Implementation Plan: Hardening Batch 1 (audit tail)

## Overview
Close the five smallest confirmed audit leftovers in one batch: `helmet` headers
without CSP (S-5, approved variant), trim `responses` from the per-quiz admin
attempt list (Z-1), add a Next middleware gate for `/admin/*` (F-3), align the
result poller with the SUBMITTED display state (F-2), delete dead
`cache.stats()` (R-3). All additive or subtractive-dead-code; no migrations, no
response-shape changes for authorized callers, no auth-logic changes.

## Architecture decisions
- Helmet WITHOUT CSP (`contentSecurityPolicy: false`): full CSP needs FE
  coordination (Bunny embed host, fonts, SurveyJS) and is explicitly deferred.
  All other default helmet headers ship (nosniff, frameguard, HSTS, referrer,
  hidePoweredBy). Frameguard SAMEORIGIN does not affect Bunny playback (those
  are Bunny's responses, not ours).
- Pin `helmet` to v7.x exact: CJS `require()` compatibility must be proven at
  install time (`node -e "require('helmet')"`) before touching `app.js`. If the
  pinned major refuses, stop and re-plan instead of forcing ESM interop.
- Z-1 keeps every field the FE grading inbox consumes; only `responses` (and
  any answer-key-adjacent field) is removed. FE already fetches single-attempt
  detail via `/quizzes/attempts/:id/result` (per frontend-handoff §99.3).
- F-3 middleware checks cookie *presence* only (no JWT verify in Edge runtime;
  no secret leaves BE). Data stays protected by BE 403s; the matcher only kills
  the flash-of-admin-shell.
- Commits split by repo: BE items one commit on `H:\e-learning-platform`
  (`ai-grader`), FE items one commit on `L:\E-LRN-FRONTEND\a-e-lrn-frontend`
  (`Dev`). Never `git add -A`; never touch user WIP files.

## Task list (also in `tasks/todo.md`)
- [x] Task 1 — helmet-without-CSP (BE, S)
- [x] Task 2 — Z-1 trim attempt-list select (BE, XS)
- [x] Checkpoint A — BE boot + header smoke
- [x] Task 3 — /admin middleware matcher (FE, XS)
- [x] Task 4 — result poller SUBMITTED align (FE, XS)
- [x] Task 5 — delete cache.stats() (BE, XS)
- [x] Checkpoint B — full verify + commits

## Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| helmet major is ESM-only / breaks boot | Med | Pin v7.x exact; `require()` probe + boot smoke before wiring; abort to re-plan on failure |
| HSTS/frameguard breaks local dev or embeds | Low | HSTS harmless on localhost; frameguard affects only our pages being iframed (nothing does); Playwright spot-checks Bunny iframe + quiz runner |
| Z-1 drops a field FE list view needs | Med | Grep FE consumers first; keep all consumed fields; detail endpoint unchanged |
| FE middleware matcher over-matches (e.g. `/admin` static) | Low | Matcher `/admin/:path*` only; verify public pages unaffected |
| `npm install` mutates lockfile unexpectedly | Low | Inspect `git diff package*.json` before committing; helmet has zero deps |

## Open questions (need human answers before/during build)
1. L-1: prod topology (proxy/LB in front?) — decides whether S-8 trust-proxy joins a later batch. NOT in this batch either way.
2. Confirm batch composition: these 5 only, Q-5/AI-4/Docker still deferred to batch 2?
