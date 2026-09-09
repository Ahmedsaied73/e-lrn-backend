# AI Grader for Quiz Essays — Plan (PAUSED, awaiting Redis + Gemini key)

## Status
**PAUSED by user (2026-09-09).** Resume trigger: user confirms Redis infrastructure is ready.
Planning only — no implementation written. Grill session completed; all choice-dependent items decided below.

## Locked decisions (user-approved, do not re-ask)
| # | Decision | Verdict |
|---|----------|---------|
| 1 | AI provider | **Google Gemini** (LangChain `@langchain/google-genai`; key in `.env`, generous free tier) |
| 2 | Job queue | **BullMQ + Redis** (user setting up Redis infra first; task paused until then) |
| 3 | Verdict storage | **New columns/table** (Prisma migration; queryable confidence/model/audit) |
| 4 | Autonomy | **Auto-finalize if confident** — applies immediately when `confidence >= 0.8`; below threshold stays `GRADING` in existing admin inbox |
| 5 | Default scope | **Per-question opt-in** — admin toggle per essay; nothing changes until enabled |
| 6 | Student waiting UX | **Light auto-refetch** — result page refetches real status ~10s while `GRADING`, stops on `GRADED`, capped ~2 min |
| 7 | Log privacy | **Include answer bodies** — full student answers + prompts in server logs for debugging (PII accepted by user decision) |

## Architecture (approved direction)
- New isolated module `src/services/aiGrader/` (`index.js` sole export, `provider.js` LangChain wrapper, `prompts.js` versioned, `schemas.js` zod + clamp, `worker.js` BullMQ processor). No renames, no rewrites.
- Single plug point: `submitAttempt` after MCQ grading when `hasEssays` — enqueue per-essay jobs, attempt stays `GRADING`.
- Persistence reuses `GRADING → gradeEssayAttempt → GRADED`; verdict recorded with `gradedBy:'ai'`, model + prompt version, confidence. Gate logic untouched (trusts only `GRADED` + passing score).
- `answerKey` extension (backward compatible): `{rubric?, ai?: {enabled}}` per comment question; `modelAnswer` already mandatory = free precondition.
- Authoring: rubric textarea + AI toggle per essay. Admin inbox: AI + confidence badges, unchanged one-click override. Human grades always win; AI skips already-graded slots.
- Input to AI only: question title, student answer (length-clamped), model answer, rubric, max points. No PII. System-prompt hierarchy + JSON-only + zod-validate + clamp; retry ×2 then human fallback.
- Cost bounded by existing `maxAttempts` + job try-cap + daily budget tripwire (Phase 4).
- Reuse path for Assignments later: generic grader input shape, caller adapter in quizService, no shared abstraction now.

## Roadmap (frozen until resume)
- P0 contract (answerKey extension + verdict metadata shape)
- P1 AI module + mock provider + unit tests (quiz untouched)
- P2 jobs (BullMQ) + worker + enqueue behind per-question flag
- P3 authoring toggle/rubric + admin badges + student auto-refetch
- P4 budgets/alerts/eval set/prompt v2

## Resume checklist (what "Redis ready" must include)
1. Redis reachable URL (local `docker run redis` or cloud) → goes in `.env` as `REDIS_URL` (exact name confirmed at resume).
2. Gemini API key in `.env` (LangChain Google var name confirmed at resume against current docs).
3. Say **"resume ai-grader"** — first actions: verify LangChain + BullMQ latest stable pins, `npm install`, P0.
