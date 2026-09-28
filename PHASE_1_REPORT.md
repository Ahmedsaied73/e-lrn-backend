# PHASE_1_REPORT.md

## 1. Goal

Make the model see its whole tool catalogue every turn — delete the per-question keyword
shortlist and the Arabic write-intent gate, remove `create_video` from the chat catalogue, and
record the bound surface's measured size per turn in the audit row.

## 2. Files changed

`git diff --stat` (plus one staged deletion):

```
 .env.example                        |  10 +-
 PROJECT_MAP.md                      |   4 +-
 src/services/agent/agentService.js  |  16 +-
 src/services/agent/graph.js         | 130 +++++--------
 src/services/agent/tools/actions.js |  60 +-----
 src/services/agent/tools/index.js   | 352 +++---------------------------------
 tests/agent-actions-crud.test.js    |   1 -
 tests/agent-graph.test.js           | 146 ++++++++-------
 tests/agent-schema-tools.test.js    |  21 ++-
 tests/agent-tools-contract.test.js  | 184 ++++++-------------
 10 files changed, plus the deleted tests/agent-actions-intent.test.js
```
(The stat printed here is the measured combined `git diff --stat 0d7f85a`. The committed
Phase 1 commit `6b079d8` shows its own stat; the correction commit below shows only its delta.)

| Path | Reason |
|---|---|
| `src/services/agent/tools/index.js` | the shortlist + write-intent machinery deleted; exports trimmed; router import removed; the surface documented where the selection used to live |
| `src/services/agent/graph.js` | both gate call sites replaced by "the catalogue"; `surfaceDefs`/`toolsForTurn`; the dead `selectFor` diagnostic removed; `turnMetrics`; per-turn `modelCalls` counter; two now-unused helpers deleted |
| `src/services/agent/agentService.js` | captures `turnMetrics()` and puts `toolSurface` + `modelCalls` into the turn detail and the `AGENT_TURN` audit row (Q3) |
| `src/services/agent/tools/actions.js` | `create_video` definition and its export entry deleted (Q6) |
| `tests/agent-actions-intent.test.js` | **deleted** — its stated purpose was the write-intent gate (see §3) |
| `tests/agent-tools-contract.test.js` | imports trimmed; allowlist minus `create_video`; the Phase 4.5 selection suite replaced by the Phase 1 surface suite |
| `tests/agent-graph.test.js` | two Phase 4.5 surface tests replaced by three Phase 1 ones + a `pinMutations` helper |
| `tests/agent-schema-tools.test.js` | import + the "a schema question selects the schema tools" test replaced |
| `tests/agent-actions-crud.test.js` | `create_video` row removed from the catalogue contract |
| `.env.example` | `AI_AGENT_ALLOW_MUTATIONS` comment now describes it as the only surface filter |
| `PROJECT_MAP.md` | tool counts corrected (31 + 21) and a v2 entry added |

No other file was touched: `git grep` across `src`, `tests` and `scripts` finds **zero** remaining
references to any removed symbol, and the only remaining `createVideo` hits are the
`bunnyVideoService` / Bunny-client / HTTP-controller paths, which Q6 says to leave alone.

## 3. What I removed / added / changed

**Removed (source).** From `tools/index.js`: `selectToolSet`, `selectDefinitions`, `hasWriteIntent`,
`isWriteToken`, `WRITE_VERBS`, `WRITE_NOUNS`, `WRITE_SUFFIXES`, `WRITE_ENABLERS`,
`AMBIGUOUS_WRITE_TOKEN`, `ACTION_NAMES`, `TOOL_LEXICON`, `STOPWORDS`, `TOOL_DESCRIPTION_TOKENS`,
`MAX_SHARED_DESCRIPTION_TOKENS`, `PHONE_DIGITS_RE`, `CORE_TOOL_NAMES`, `MAX_READ_TOOLS_PER_TURN`,
the `INTENTS/normalize/tokenize/route/...` router import, and the eight exports that existed only
for them. From `graph.js`: `latestQuestionText`, `historyToolNames` (unused once the surface stopped
depending on the question) and the `selectFor` diagnostic. From `actions.js`: the `create_video`
tool and its export entry.

**Added (source).** `graph.js`: `surfaceDefs()` (the single place the switch is applied),
`toolsForTurn()` (memoized on the switch alone), `turnMetrics()`, and a per-turn `modelCalls`
counter. No dead diagnostic was kept: the old `selectFor(question, historyTools)` is gone, not
renamed — its two parameters had no referent once the surface stopped depending on the question.
`agentService.js`: the `turnMetrics()` read plus two detail/audit fields. Nothing else — no new
tool, no new endpoint, no new config.

**Changed (behaviour).** The model-facing surface is now `listDefinitions()`
(`AI_AGENT_ALLOW_MUTATIONS` is the only filter) instead of a per-question shortlist of 3–8 reads
plus an imperative-gated action set. Catalogue: **31 read + 21 action = 52** (was 31 + 22).
Everything else in the tool layer is untouched: strict Zod parsing, row and char caps, PII
redaction, the audit row, the `approved` gate, the tool budget, the grounding guard and the
deterministic fast path.

### Tests deleted, and why (rule 6)

| Deleted test | Where | Why it is gone by decision |
|---|---|---|
| the whole file (13 tests) | `tests/agent-actions-intent.test.js` | its docstring states its purpose: "the graph now binds the actions only for a turn that LOOKS like a write. That gate is a heuristic" — the gate no longer exists. The real regression it protected (a write request the agent refuses) is re-pinned in `agent-graph.test.js` |
| `the model is shown a SHORT tool surface, not the whole catalogue` | `agent-graph.test.js` | asserted `bound.length <= 8`; the trim is the removed behaviour |
| `a tool the question names is exposed even though it is not core` | `agent-graph.test.js` | asserted question-driven selection; every read tool is now bound, so the new "whole read catalogue" test supersedes it |
| `trimming the surface does not shrink the execution authority` | `agent-graph.test.js` | its premise (a read tool off the shortlist yet executable) cannot arise; replaced by the switch-vs-display authority test |
| `never exposes an empty surface, and always the core set` | `agent-tools-contract.test.js` | no selector, no empty-surface failure mode |
| `caps the read surface and hides actions unless mutations are armed` | `agent-tools-contract.test.js` | the read cap is gone; both directions of the switch are re-pinned |
| `binds an action tool for a write question when mutations are armed` | `agent-tools-contract.test.js` | superseded by the stronger "whole catalogue for ANY question" test |
| `keeps the write question action-free under the read-only default` | `agent-tools-contract.test.js` | folded into the new reads-only test |
| `picks the tool the question is actually about` | `agent-tools-contract.test.js` | question-driven selection removed |
| `keeps the tools a follow-up turn already used` | `agent-tools-contract.test.js` | existed only because the surface could lose a tool mid-thread; impossible now |
| `is deterministic: the same question always gets the same surface` | `agent-tools-contract.test.js` | the surface no longer reads the question, so this is structurally true; the new suite asserts the surface equals the catalogue instead |
| `is SMALLER than the full catalogue — the reason this module exists` | `agent-tools-contract.test.js` | it asserts the exact behaviour the phase removes |
| `leaves no read tool unreachable: every tool has selectable vocabulary` | `agent-tools-contract.test.js` | reachability no longer depends on vocabulary; replaced by "can bind every tool" |
| `is reachable: a schema question selects the schema tools` | `agent-schema-tools.test.js` | replaced by "a schema tool is in the read catalogue and on every turn" |

### Tests added

- `agent-graph.test.js`: `binds every read tool and no action while mutations are off`,
  `binds the WHOLE catalogue — actions included — for a question with no write verb` (the phase's
  definition of done, asserted from the **bound tools captured on a mocked/scripted LLM call**),
  and `the mutation switch, not the display surface, decides what the ToolNode can execute`.
- `agent-tools-contract.test.js`: `binds the whole read catalogue, and no action, while mutations
  are off`, `binds the WHOLE catalogue for any question once mutations are armed`,
  `can bind every tool in the catalogue (nothing is undeliverable)`, and
  `measures the surface it binds, for the per-turn audit row (Decision Q3)`.
- `agent-schema-tools.test.js`: `is reachable: a schema tool is in the read catalogue and on every
  turn`.

No other test was removed or weakened.

## 4. Evidence

### 4.1 The full agent suite, with the row cap pinned to its shipped default

```
$ $env:TEST_BASE_URL='http://127.0.0.1:3106'; $env:AI_AGENT_MAX_TOOL_RESULT_ROWS='50'
$ node --test --test-concurrency=1 tests/agent-*.test.js tests/ai-agent-*.test.js      # 21 files
ℹ tests 246
ℹ suites 25
ℹ pass 246
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 154099.0607
```

246 = the Phase 0 baseline's 259 minus the 13 tests in the deleted intent-gate file. Zero
failures; no `✖` line anywhere in the output. The new tests, as they printed:

```
✔ binds every read tool and no action while mutations are off (14.3564ms)
✔ binds the WHOLE catalogue — actions included — for a question with no write verb (19.4928ms)
✔ the mutation switch, not the display surface, decides what the ToolNode can execute (12.9302ms)
      [tool surface] read-only 10208 chars (~2552 tokens) | all 16275 chars (~4069 tokens)
  ✔ can bind every tool in the catalogue (nothing is undeliverable) (7.409ms)
  ✔ measures the surface it binds, for the per-turn audit row (Decision Q3) (2.2429ms)
  ✔ is reachable: a schema tool is in the read catalogue and on every turn (0.3305ms)
```

Note the second new test is the phase's definition of done in the exact form it asks for: the
question is `«إزيك؟»` (no write verb anywhere), the LLM is **scripted**, and the assertion is made
against the **bound tool list the mocked call received** (`model.calls[0].toolNames`), never against
model prose. It requires `readDefinitions.length + actionDefinitions.length` tools and specifically
that `delete_user` is present.

### 4.2 The surface, measured directly (`node -e` against the real modules)

```
ARMED  tools=52 chars=16275 tokens=4069      has delete_user: true | has create_video: false
READS  tools=31 chars=10208 tokens=2552
turnMetrics (no model call yet) = {"modelCalls":0,"toolSurface":null}
```

`surfaceDefs()` returns what `toolsForTurn` would bind under the current switch; the numbers below
are the same ones the audit row stores (chars are the honest part; tokens are the repo's chars/4 rule
of thumb). Measured after the deletion of the `surfaceFor` probe, by calling the same
`listDefinitions()` + `approximateSchemaTokens()` the graph uses:

### 4.3 The Q3 measurement, verified end-to-end on a live turn

Printing the three most recent `AGENT_TURN` rows from the audit table after the suite ran
(the suite *is* the traffic — two of these are the new tests' turns):

```
audit#1507 tier=llm toolCalls=["mark_enrollment_paid"] modelCalls=2 toolSurface={"chars":16275,"tools":52,"tokens":4069}
audit#1506 tier=llm toolCalls=["mark_enrollment_paid"] modelCalls=2 toolSurface={"chars":16275,"tools":52,"tokens":4069}
audit#1504 tier=llm toolCalls=["platform_overview"]    modelCalls=2 toolSurface={"chars":16275,"tools":52,"tokens":4069}
```

So the number Decision #15's revisit trigger needs is now in the table, per turn, with no new
config and no behaviour change.

### 4.4 Lint and diff hygiene

```
$ node node_modules/eslint/bin/eslint.js src app.js
(no output)      exit 0
```

`git diff --stat` shows proportional edits per file (no whole-file rewrite), `node --check` passes on
every edited file, and the BOM + CRLF of `src/services/agent/tools/index.js` were preserved
(verified after each splice: `bom=true crlf=302`).

## 5. Definition of done

| Criterion (handoff §4 Phase 1 + your GO answers) | Status | Proof |
|---|---|---|
| `tools/index.js`: `selectToolSet`, `hasWriteIntent` and their keyword tables removed | **MET** | §3; `git grep` for any of the 16 removed names returns nothing in `src`/`tests`/`scripts` |
| Both `graph.js` call sites no longer gate on `hasWriteIntent` | **MET** | `graph.js` now has one `surfaceDefs()`: `includeActions ? listDefinitions() : listDefinitions().filter((d) => d.kind === KIND_READ)`; the question-keyed `selectFor` diagnostic was deleted along with its dead parameters |
| The phase's definition of done: "what can you do?" with mutations enabled surfaces the write capabilities, **asserted via a mocked LLM call capturing the bound tools** | **MET** | §4.1 — `binds the WHOLE catalogue — actions included — for a question with no write verb` asserts on `model.calls[0].toolNames` (scripted model), requires all 52 tools and `delete_user` |
| Q3: bind everything every turn (no pre-emptive grouping) + per-turn measurement in the audit metadata (surface token size + model calls) | **MET** | §4.2/§4.3 — `toolSurface: {tools, chars, tokens}` and `modelCalls` in the live `AGENT_TURN` rows |
| Q6: `create_video` deleted from the tool definition **and** the export list; counts updated wherever asserted | **MET** | §4.2 (`has create_video: false`, `tools=52`); `actions.js` export list; both test allowlists; `PROJECT_MAP.md` corrected |
| Q6: `delete_video`, `reorder_course_videos`, `mark_video_failed`, the HTTP video routes and the `VIDEO_CREATE` audit action untouched | **MET** | all three tools still exported; `git grep createVideo` shows only the untouched service/controller/Bunny paths |
| Tests updated (not whole files deleted) where assertions referenced the removed selector | **MET** | §3 table: 14 individual assertions replaced/removed with stated reasons; only the file whose *sole* purpose was the gate was deleted |
| Full agent suite green | **MET** | §4.1 — 246/246, 0 fail |
| Lint clean | **MET** | §4.4 — exit 0 |
| `AI_AGENT_ALLOW_MUTATIONS="true"` set in the **staging** `.env` | **NOT MET (owner action)** | that is a Railway runtime variable, outside this repo. It is already `true` in the local `.env`, so no code depends on me setting it. **You must set `AI_AGENT_ALLOW_MUTATIONS=true` on staging yourself.** |

## 6. Assumptions — signed off (owner, this round)

The five items I put to you, with your decisions. No code in this phase goes beyond them.

1. **`selectFor` was deleted, not replaced.** As you signed off: `surfaceFor()` was my own new code
   with zero callers, so it is gone rather than renamed (committed below, in the correction commit).
   `turnMetrics()` — which *is* called by `agentService.js` and asserted by
   `tests/agent-graph.test.js:253` — is the turn-measurement seam that stays.
2. **The per-turn memo is now keyed on the switch alone** (`selection.key = 'surface|' + includeActions`).
   Kept, per your sign-off. Its purpose (bind one surface per turn instead of re-deriving per model
   call) is unchanged; the question/history parts of the key were removed with the selection they keyed.
3. **The `actions.js` section headers are ASCII, and the file is now internally consistent.** Signed
   off with your instruction to standardise: the file has three `// --- Name (context) ---` banners
   and no remaining box-drawing characters (was 2 of those). The other agent files were checked and
   left alone: each uses exactly one banner style throughout, so none of them was mixed.
4. **`AI_AGENT_MAX_TOOL_CALLS=20` in the local `.env` is silently clamped to 10** by `env.js:273`.
   Kept, per your sign-off: the clamp stays, and the local `.env` value is your runtime config, which
   I never commit.
5. **The Phase-0 convention of pinning `AI_AGENT_MAX_TOOL_RESULT_ROWS=50`** for every run is still what
   I used (it is what makes the suite green in this checkout). Kept, per your sign-off.

## 7. Noticed, not touched

- **`tools/index.js` had six double-encoded (mojibake) comment lines, now repaired.** A
  byte-level census (exactly two corrupted 3-code-point sequences —
  `[226, 8364, 8221] ×6` (em dash) and `[226, 8364, 166] ×1` (ellipsis) — in header/measure/
  transport comments) proved nothing else in `src/`, `app.js` or `.env.example` was affected.
  The repair was a deterministic 7-replacement byte mapping (committed below), verified by
  re-running the census (0 remaining), `node --check`, `eslint src app.js` (exit 0) and the full
  agent suite (246/246, 0 fail). BOM and CRLF are preserved. Nothing else was re-encoded —
  the files' Arabic is intact. This repair is the only item in this report and commit that goes
  beyond the five sign-offs above, and it is reported here on purpose: it touches seven comment
  lines in a file this phase already owned.
- **`actions.js` is now internally consistent in its banner style** (all three section headers use
  `// --- Name (context) ---`; no box-drawing remains) since your sign-off asked for it. The other
  agent module files were scanned and each uses exactly one banner style throughout, so they were
  not touched.
- **`PROJECT_MAP.md` line 42 is stale**: it says `AI_AGENT_CONVERSATION_RETENTION_DAYS` "is still
  resolved and clamped but read by nothing — no retention/pruning job exists yet", while
  `src/jobs/pruneAgentConversations.js` exists, is wired at `app.js:452-456` and runs daily at 03:17.
  Out of this phase's scope; left as written (I appended a separate v2 bullet instead).
- **`requiresApproval: true` still on every action**, and the whole HITL REST + socket surface
  (`POST /admin/agent/approvals`, `/approvals/:id/decide`, `agent:decide`, `findRefusedMutation`,
  `approvalRequested`) is untouched, per your Q2 answer. Phase 3 will make them inert; today they still
  pass their own suites.
- `scripts/smoke-agent.js` / `scripts/agent-latency.js` never referenced the removed symbols (checked);
  the smoke script's catalogue summary will simply report 52 tools now.
- `logs/agent-baseline.log` and `logs/agent-run1.log` are untracked artifacts from an older worktree
  (they point at `C:\Users\Ahmed Saied\.cline\worktrees\806ac\...`) and reference old line numbers;
  ignored.

## 8. Next phase risks (Phase 2)

- **The system prompt is still the report-writer.** Phase 2 replaces `SYSTEM_PROMPT` (`graph.js:33`,
  still a module `const`) with a per-turn builder. This phase deliberately left it a const and left
  `agentNode` reading it directly, so Phase 2 must change both — and it must **not** mention pending
  approvals (your Q2 answer).
- **Until Phase 2 lands, prompt and surface are inconsistent**: the model can now call 21 write tools
  while the prompt still tells it "النظام يطلب موافقة المشرف تلقائياً… بعد استدعاء الأداة، أخبر المشرف
  باختصار أن الطلب مُرسل وأنتظر موافقته". Safe today (the `approved` gate still refuses the mutation),
  but do not run a staging smoke test expecting writes to succeed before Phase 3.
- **Cost is now recorded, not guessed**: ~16.3k chars (~4.1k tokens by the proxy; ~9.5k tokens of real
  model-facing JSON per my Stage-1 measurement) per model call, and `modelCalls=2` on a simple
  tool-using turn. After you enable `AI_AGENT_ALLOW_MUTATIONS` on staging and ask a multi-step question,
  read `toolSurface`/`modelCalls` off the `AGENT_TURN` audit row before the provider's per-minute limit
  tells you the same thing less kindly.

