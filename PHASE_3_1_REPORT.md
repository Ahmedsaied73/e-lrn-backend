# PHASE_3_1_REPORT.md

## 1. Goal

Close the review findings F1–F5 on `agent-v2-rebuild` before anything is built on top of Phase 3,
and before `AI_AGENT_ALLOW_MUTATIONS` is enabled anywhere. Phase 4 starts only after this commit
is reviewed.

| Finding | Severity | Status |
|---|---|---|
| F1 — the confirmation was not tied to a later turn (C1) | HIGH | Fixed, pinned at unit and graph level |
| F2 — previews and refusals filed as deletions in the audit log | MEDIUM | Fixed, pinned |
| F3 — broadcast preview accepted a wrong recipient count | MEDIUM | Fixed, pinned |
| F4 — confirmation TTL defaulted to 15 min (spec: 5) | LOW | Fixed, pinned |
| F5 — stale comments describing the removed approval flag / old surface | LOW | Fixed |

## 2. Files changed

```
 src/services/agent/tools/_kit.js       |  turn boundary + conversation binding in the token
                                           gate, toDate() helper, stage-named audit actions
 src/services/agent/approvals.js        |  requestedAt written from the NODE clock; header
                                           rewritten (two consumers, one ledger)
 src/services/agent/agentService.js     |  server-set turnStartedAt threaded into the tool
                                           context; duplicate resolver removed
 src/services/agent/graph.js            |  header/comment truth (attribution + turn binding)
 src/services/agent/tools/actions.js    |  broadcast preview enforces expectedRecipients
 src/config/env.js                      |  confirmationTtlMinutes default 15 -> 5
 .env.example                           |  documents the same-turn rule + default 5
 tests/agent-actions-crud.test.js       |  4 new pins, 1 corrected
 tests/agent-graph.test.js              |  1 new end-to-end pin
 tests/ai-agent-config.test.js          |  3 new TTL pins (default + both clamps)
 PHASE_3_1_REPORT.md                    |  this file
```

## 3. What changed, precisely

### F1 — the turn boundary (the reason this round exists)

- `answerQuestion` stamps `turnStartedAt = new Date().toISOString()` **once per turn**, before the
  graph is built, and passes it into `createApprovalResolver`.
- The resolver puts it in the context **it returns**, never in the context it receives from the
  model: `base = { prisma, adminId, conversationId, turnStartedAt }`. The model's arguments go
  through `resolveToolContext(args, def)` and cannot touch those fields.
- `tools/_kit.js` coerces it with a new `toDate()` (ISO string in production — the context crosses
  the LangChain serialization boundary — a `Date` in direct calls; `null` when absent) and the token
  gate refuses in this order: row → owner → status → expiry → **same turn** → **conversation** →
  argument hash → consume.
- The refusal is `CONFIRMATION_SAME_TURN`, and it is a **typed refusal payload**, not a throw, like
  every other token failure — so the model can explain it and the admin sees it.
- The refusal does **not** spend the token (`status` stays `PENDING`), so the very same token works
  when the admin answers in the next turn. The guard is about *when*, not about poisoning the flow.
- Fail-closed detail: when a turn boundary IS supplied and the row's `requestedAt` is unreadable, the

### F2 — stage-named audit actions

`recordAudit` now builds the action name as `<declared action><suffix>` where the suffix comes from
the stage: `preview` → `_PREVIEW`, `confirm_refused` → `_REFUSED`, everything else (i.e. the executed
row) keeps the historical name. So: `VIDEO_DELETE_PREVIEW`, `VIDEO_DELETE_REFUSED`, `VIDEO_DELETE`.
A preview that found nothing to delete is filed as `_PREVIEW` too — the stage it happened in — with
the refusal detail in the payload. The agent's audit reader (`operations.js:107`) filters `action` by
exact match, so "what did I delete this week?" can no longer count previews; `platform.js`'s
recent-actions list now *labels* them instead of mixing them in.

### F3 — broadcast preview enforces the count

The preview applies the same `RECIPIENT_COUNT_MISMATCH` guard `run()` applies, before issuing a token.
The count is part of the hashed arguments, so a wrong guess previously produced a token that the
corrected confirm call could never satisfy — a guaranteed wasted round trip, and a live token for a
send nobody agreed to.

### F4 + F5

- `AI_AGENT_CONFIRMATION_TTL_MINUTES` default 15 → **5** (cap 1..30 unchanged, still the
  `approvals.js` ceiling). `.env.example` explains that the window is "how long the admin has to
  answer", not a grace period for the model.
- Comment truth: `tools/actions.js`'s doctrine block no longer claims `ctx.approved === true` gates
  anything; `graph.js`'s header and ToolNode note name the real guards (attribution + confirmation +
  turn binding); `approvals.js`'s header describes the two consumers of the ledger and the Node-clock
  rule. The vestigial `approved: true` field the resolver used to return is gone with the duplicate
  resolver (see §5).

## 4. Verification (measured, not asserted)

| Run | Result |
|---|---|
| affected suites (`agent-actions-crud`, `agent-graph`, `agent-tools-contract`, `agent-answer-guard`, `ai-agent-config`) | **78/78 pass**, 0 fail, ~6.8 s |
| `eslint` on `src/services/agent` + `src/config/env.js` | clean (exit 0) |
| full `npm test` (self-hosting, port 3106) | see §4.1 |
| Phase 3 baseline re-run on the pre-3.1 tree | 67/67 (recorded in `PHASE_3_REPORT.md`) |

New pins: same-turn refusal **with the token still PENDING**, and the same token succeeding in a later
turn; cross-conversation token refusal; broadcast wrong-count preview issuing no token; `_PREVIEW` /
`_REFUSED` / plain action-name assertions; the end-to-end graph pin (a scripted model that previews and
then confirms from the returned token inside ONE turn → `CONFIRMATION_SAME_TURN`, `deleteVideo` never
called, row still `PENDING`); three TTL assertions (default 5, clamp 30, clamp 1).

### 4.1 Full suite (measured on this commit)

`npm test` — the self-hosting runner (spawns the app on 3106, `tests/**/*.test.js`, ~7 min):

| Metric | Value |
|---|---|
| tests | **300** |
| suites | 38 |
| pass | **294** |
| fail | 2 (both attributed below) |
| skipped | 4 |

Neither failure involves this diff:

1. **`agent tool payload cap — a small payload is untouched`** — the environment issue Phase 0
   documented: the local `.env` carries `AI_AGENT_MAX_TOOL_RESULT_ROWS=100`, while that file asserts the
   *shipped* default of 50 (`meta.cappedAt`). Proven by running the file alone both ways: cap pinned to
   50 → **12/12 pass, exit 0**; cap left at the `.env` value → fail with `actual: 100, expected: 50`.
   It is an environment override, never a code change.
2. **`payments lifecycle — a racing pair of success callbacks fulfils only once`** — a timing-sensitive
   race test; the runner's own comment says this suite and `quiz lifecycle` "contend for the connection
   pool and flake intermittently". Re-running the same file against the same tree went **green**
   (`✔ payments lifecycle (simulated provider callbacks)`), with every other payment case passing in
   both runs. The payments module never imports the agent tools, so this diff cannot reach it.

Agent suite with the row cap pinned (the Phase 0 comparator), 21 files, `--test-concurrency=1`:

| Metric | Value |
|---|---|
| tests | **258** |
| suites | 25 |
| pass | **258** |
| fail | **0** |
| duration | 171 s |

(Phase 0's baseline recorded 259 tests across 22 files. The suite composition changed across Phases 1–3 —
the Phase 1 surface rewrite deleted and consolidated tests — so the comparable statement is the one
above: every file in the agent suite is green on this commit.)

Also run: repo-wide `eslint .` → **clean (exit 0)**.

**Not verified on this commit**: any live Gemini turn, the `RUN_LIVE_AGENT=1` smoke, the staging
deployment, and the UI. Those stay as they were for Phase 3.

## 5. Anything unexpected

- **The guard's weakest link is its own wiring, and a test caught it.** `resolveToolContext` runs once
  per TOOL CALL, so stamping the turn inside the resolver makes each call look like a new turn: a
  same-turn confirmation sailed through on the first attempt. The production path stamps once per turn
  in `answerQuestion` (correct), so the defect was only in the test — but a future refactor that moves
  the stamp one level down would silently disable F1 with every unit test still green. That is why the
  end-to-end pin exists and why both the resolver doc and the test carry the warning.
- **Preview refusals are `_PREVIEW`, not `_REFUSED`.** The naming follows the STAGE the call happened
  in (F2 says "preview and refusal rows get their own names"), so a preview that found nothing to
  delete is `VIDEO_DELETE_PREVIEW` with the reason in the payload, while `_REFUSED` is reserved for a
  refused *confirmation* — the path that must never be mistaken for a deletion. A Phase 3 assertion
  that expected `VIDEO_DELETE` for exactly that case was itself pinning the bug; it is corrected, not
  deleted.
- **A duplicate resolver had to be removed.** While rewriting the resolver's doc block, the edit
  inserted a second `createApprovalResolver` above the original; the later declaration would have won
  and `turnStartedAt` would have been dropped on the floor **with all new tests still failing loudly**
  (they did). It was found immediately by grepping the symbol count, and removing the stale copy also
  removed the last vestigial `approved: true` return.
- **The local `.env` arms mutations** (`AI_AGENT_ALLOW_MUTATIONS="true"`) and sets no
  `AI_AGENT_CONFIRMATION_TTL_MINUTES`, so dev now runs the new 5-minute default. Staging and production
  must stay unarmed until this commit is reviewed — the review's constraint is unchanged by this round,
  it is only satisfied.
- The F6 observations from the review are deliberately unchanged: the token is consumed before `run()`
  (a failed `run()` needs a fresh preview — accepted), the broadcast 500-recipient ceiling stays, and
  the legacy REST/socket decision endpoints remain mounted (a decide on a confirm row makes it
  non-`PENDING`, so the token fails closed).

## 6. Deviations from the task

- F1–F5: implemented as specified, one violation fixed by design decision (the same-turn check runs
  **before** the hash comparison and before the consume, so a same-turn probe cannot spend the token of
  a preview the admin was still reading).
- Scope correction, not scope creep: `PHASE_3_REPORT.md` §7 promised Phase 4 a module-level
  `getTurnContext()` carrying `turnStartedAt`. That claim was wrong and is amended **in this commit**:
  the anchor rides the tool-context resolver instead, and no process-wide "current turn" object was
  added (it would be shared across concurrent admin turns). §7 now says so explicitly.
- Nothing else was touched: no schema change, no migration, no new endpoint, no dependency.

## 7. What the next phase must know

- The confirmation flow is now: preview (no token) → **admin replies in a later turn** → confirm with
  the token. `CONFIRMATION_SAME_TURN` is the new typed refusal; the token stays `PENDING` and reusable
  across the remaining TTL window.
- Do not move the per-turn stamp into the resolver, and do not derive it from anything the model sends.
- The full-suite result for this commit is in §4.1; anything not listed there (live Gemini, staging, the
  DB-backed `agent-schema-tools` suite) is still unverified for this commit.

PENDING — filled from the `npm test` run started in this round.

  confirmation is refused too — an unprovable timestamp is not a proof of age. The column is NOT NULL
  in the model, so this only affects hand-written stub rows.
- `requestApproval` now writes `requestedAt` from the Node clock instead of leaving it to the column's
  `@default(now())`. Both sides of the comparison must come from the same clock: the DB clock is a
  separately-synchronised clock reached through the pooler.
- **Wiring trap found while testing** (documented in `agentService`): the resolver is invoked **per
  tool call**, so a `new Date()` inside it re-stamps the turn for every call and the boundary would
  never be crossed. The stamp must be computed once per turn, outside the resolver. The first version
  of the new graph test made exactly this mistake and let a same-turn confirmation through — proof
  that this guard needed a pin at the graph level, not only at the unit level.
