# PHASE_3_REPORT.md

> **Written retroactively** (2026-09-29, Phase 3.1 round). The external review of
> `agent-v2-rebuild` @ `7ae8f80` found this file missing — the process rule is "write the report,
> then stop", and Phase 3 broke it. Everything below describes the branch exactly as it shipped in
> commits `a6b3ace` + `7ae8f80`; anything that has since changed is marked and belongs to
> `PHASE_3_1_REPORT.md`.

## 1. Goal

Replace the approval flag with **preview-then-confirm** for the destructive tools, and make
attribution — not an `approved` boolean — the only permission the tool layer trusts (phase prompt
§1, requirements C1–C8).

## 2. Files changed

| Commit | Files | What |
|---|---|---|
| `a6b3ace` (tests, committed **first** — see §6) | `tests/agent-actions-crud.test.js` +294, `tests/agent-tools-contract.test.js` +66, `tests/agent-graph.test.js` +88, `tests/agent-tools-db.test.js` +14 | Pins the confirm-token flow, `ADMIN_REQUIRED` attribution, dynamic config caps |
| `7ae8f80` (implementation) | `src/services/agent/tools/_kit.js` +276, `src/services/agent/tools/actions.js` +204, `src/services/agent/graph.js` +102, `src/services/agent/tools/index.js` +32, `src/services/agent/agentService.js` +17, `src/config/env.js` +5, `.env.example` +5, `PHASE_1_REPORT.md` ±14, `PHASE_2_REPORT.md` +96 | Everything below |

## 3. What changed, precisely

1. **`confirmableActionTool`** (new factory in `_kit.js`) — the five destructive tools
   (`delete_user`, `delete_course`, `delete_video`, `delete_quiz`, `broadcast_notification`) moved
   from `actionTool` to it. A call with no `confirmationToken` runs `preview()` (read-only), hashes
   the args, inserts one `AgentApproval` row with `status = PENDING`, and returns
   `{ stage: 'PREVIEW', preview, confirmationToken }`. A call **with** a token verifies the row
   (owner, tool, PENDING, not expired, argument hash), **consumes it with one conditional
   `updateMany`** (so it cannot be spent twice, even concurrently), then runs `run()`.
2. **`approvals.js`** gained `issueConfirmationToken()` and `verifyConfirmationToken()`. The token is
   the `AgentApproval` row id as a string; foreign/unknown ids and stale rows are refused **before**
   any target lookup, and a consumed row replays as `CONFIRMATION_MISMATCH` (no ownership oracle).
3. **The approval flag died.** `actionTool` no longer reads `ctx.approved`; the surviving check is
   `ADMIN_REQUIRED` — a mutation with no attributable admin id is refused before it resolves its
   target. `agentService`'s resolver stopped gating on an open approval and always hands the tool
   layer its full context (it still sets a vestigial `approved: true` — nothing reads it).
4. **`env.js`**: `confirmationTtlMinutes` — default **15**, clamped to [1, 30] (deviation, see §6).
5. **Legacy approval machinery kept**: the REST decide endpoint and the socket `agent:decide` remain
   mounted; a `decide` on a confirm row makes it non-`PENDING`, so the token fails closed. Safe by
   construction, reviewed as such.
6. **`graph.js` in this commit also contains Phase 2's code** (`buildSystemPrompt`,
   `formatCairoDate`, `MEMORY_BLOCK_LABEL`) — it should have been its own commit (see §6).

## 4. Verification (measured, not asserted)

Baseline re-run on this commit on 2026-09-29, no database, `AI_AGENT_MAX_TOOL_RESULT_ROWS=50`
(the Phase 0 pin; the local `.env` carries 100 and would fail three `meta.cappedAt` pins):

| Run | Result |
|---|---|
| `node --test tests/agent-tools-contract.test.js tests/agent-actions-crud.test.js tests/agent-graph.test.js tests/agent-answer-guard.test.js` | **67/67 pass** (26 + 14 + 12 + 15), 0 fail, ~5.9 s |

The external reviewer independently ran the same four files against a stub Prisma client:
26/26, 14/14, 12/12, 15/15 — same result. **Not run here**: the full suite, the DB-backed agent
suites, `agent-schema-tools`, live Gemini calls, anything on staging. The 3.1 report carries the
full-suite numbers.

## 5. Anything unexpected

- **The two-step gate has no server-side turn boundary.** Preview and confirm issued inside ONE
  agent turn both succeed and the delete executes — the only barrier was a sentence in the prompt
  telling the model not to call again. The reviewer reproduced it with the real `execute()` and a
  spy (`same-turn confirm ok: true`). Student-authored text (essay, notification body) reaching the
  model's context could therefore drive a preview + confirm without a human answering. Requirement
  **C1** ("the server refuses a confirmation made in the same turn as its preview") was not
  implemented. This is finding **F1 — HIGH**, and it is why `AI_AGENT_ALLOW_MUTATIONS` must stay
  false on staging/production until 3.1 lands.
- **The token is consumed before `run()` executes.** If `run()` then fails (Bunny down, FK caught),
  the token is spent and a fresh preview is needed. Accepted: retrying a half-failed destructive
  call with a still-valid token would resurrect exactly the double-spend C1 is meant to prevent.
- **Audit rows for preview and refusal share the real action name** (`USER_DELETE` with only
  `metadata.stage` distinguishing them), and the agent's own audit-reading tools do not filter on
  `stage`, so "what did I delete this week?" counted previews. Finding **F2**.
- **Broadcast preview did not check `expectedRecipients`** against the real audience: a wrong guess
  issued a token that the corrected confirm call could never satisfy (hash mismatch) — a guaranteed
  wasted round trip. Finding **F3**.
- The broadcast 500-recipient cap stayed (Decision #9 only mandates the two-step flow for broadcast;
  the ceiling was never discussed — kept and documented).

## 6. Deviations from the phase prompt

1. **C1 missing** (same-turn refusal) — carried into 3.1 as F1.
2. **No report written at the time** — this file is the retroactive remedy, committed standalone so
   the history stays honest about it.
3. **TTL default 15 instead of the specified 5** (C4) — finding F4, corrected in 3.1.
4. **Commit order**: the Phase 3 tests (`a6b3ace`) shipped *before* the implementation, so that
   commit alone does not pass its own tests; Phase 2's code rode inside the Phase 3 implementation
   commit. Neither is dangerous; both hurt bisection. Recorded, not rewritten.
5. **Preview/refusal audit rows reuse the real action name** (F2) and **broadcast preview skips the
   recipient-count check** (F3) — both corrected in 3.1.

## 7. What the next phase must know

- **3.1 first** (F1–F5, one commit + report). F1's shape: `turnStartedAt` is **server-set** (an
  ISO string, so it survives the LangChain serialization boundary of the context resolver) and
  travels `answerQuestion → createAgentGraph → resolver → runCtx`; `_kit` refuses with
  `CONFIRMATION_SAME_TURN` when the preview row was created at/after it, **before** consuming;
  the preview row's `requestedAt` must be set from the Node clock so both timestamps share one
  clock (the DB `@default(now())` would mix clocks with pgbouncer).
- **Phase 4** (context compaction): read `getTurnContext()` from `graph.js` — it already carries
  `turnStartedAt` (added by 3.1) alongside `toolPayloads`/`conversationId`.
- Do not enable `AI_AGENT_ALLOW_MUTATIONS` on staging/production until 3.1 is merged and reviewed.

