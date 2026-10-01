# ADMIN_AGENT_REBUILD — Stage 1: UNDERSTANDING REPORT

Read-only stage. No file in this repository was created, edited or deleted except this report.

## 0. Branch and tip (the confirmation you asked for)

```
$ git fetch origin                       # FETCH OK
$ git checkout -b agent-v2-rebuild origin/Dev
branch 'agent-v2-rebuild' set up to track 'origin/Dev'
$ git log -1 --format='%H%n%ad%n%s'
c51e986c8289946fc25612c597c69c7bcc9a64d5
Mon Sep 28 03:17:43 2026 +0300
fix(agent): Egyptian-dialect write intent + student_search boost for phone lookups
```

**Tip = `c51e986` on branch `agent-v2-rebuild` (== `origin/Dev`).** `git status` shows only
pre-existing untracked scratch files (`.superpowers/`, `boot-*.txt`, `loadtest/`, …) that were
already in the working tree before I started; `git diff --stat` is empty.

Divergence check (confirms the handoff's branch note):

```
$ git log --oneline origin/Dev...origin/staging --left-right
> d88f9f8 new pc upload
< c51e986 fix(agent): Egyptian-dialect write intent + student_search boost for phone lookups
> 6dd3bb9 fix(agent): Egyptian-dialect write intent + student_search boost for phone lookups
```

`Dev` and `staging` have diverged by exactly one commit each. Building on `origin/Dev` is correct.

## 1. The goal, in my own words

Turn the existing `/admin/agent` feature — today a 28-intent keyword router with a rigid
report-writing prompt, a keyword gate that hides all 22 write tools unless the admin's single
message contains an Arabic imperative, and a grounding guard that throws the whole answer away
when it sees a number it cannot trace to a tool payload — into a conversational Egyptian-Arabic
copilot for the single platform admin, who must be able to read anything and change anything
(students, courses/videos, quizzes, enrollments/payments, notifications, essay grading) from chat.
Concretely: the model sees **all** its tools every turn (no keyword gate, no intent router as a dead
end), writes like a colleague instead of a report, executes ordinary writes immediately while
destructive ones (delete x4 + broadcast) require a server-enforced two-step preview/confirm behind a
real token check, never has an answer silently discarded by the number guard, runs on Gemini only
(no Groq, no Pro), remembers useful facts across conversations for 30 days, and can search /
regenerate / edit its own transcripts.

## 2. Baseline test results (Step 3)

**How a single file is run (verified, not assumed).** `scripts/run-tests.js` has **no file filter**:
it spawns `node app.js` on `TEST_PORT` (3106), polls `/health`, then runs
`node --test --test-concurrency=1 tests/**/*.test.js` with `TEST_BASE_URL` set, and only ever runs
the **whole** suite. So a single file is run the `test:direct` way: start the server yourself, then
point `node --test` at files with `TEST_BASE_URL=http://127.0.0.1:3106`. `package.json` has exactly
two entry points: `test` (the self-hosting runner) and `test:direct`
(`node --test "tests/**/*.test.js"`, against an already-running server).

I started `node app.js` with `PORT=3106 NODE_ENV=development` (agent mounted:
`[INFO] Agent REST mounted: /admin/agent`, `[INFO] Agent WebSocket mounted at /agent-ws`) and ran the
**22 agent files unmodified** (20 x `tests/agent-*.test.js` + 2 x `tests/ai-agent-*.test.js`):

```
$ node --test --test-concurrency=1 tests/agent-*.test.js tests/ai-agent-*.test.js
ℹ tests 259
ℹ suites 26
ℹ pass 256
ℹ fail 3
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 150745.6937
```

### The 3 failures are environmental, not defects — and here is the proof

All three assert the **default** row cap of 50 while the developer's local `.env` sets
`AI_AGENT_MAX_TOOL_RESULT_ROWS=100`:

| Test | File:line | Assertion | Actual vs expected |
|---|---|---|---|
| `is byte-identical to the pre-cap finalize() output` | `tests/agent-tool-payload-cap.test.js:150` | `result.meta.cappedAt === 50` | 100 !== 50 |
| `redacts emails and attaches meta to a read payload` | `tests/agent-tools-contract.test.js:218` | `meta.cappedAt === 50` | 100 !== 50 |
| `runs a real read tool end to end against a stub pool (no DB)` | `tests/agent-tools-contract.test.js:231` | `meta.cappedAt === 50` | 100 !== 50 |

Re-running just those two files with the cap pinned to its default:

```
$ $env:AI_AGENT_MAX_TOOL_RESULT_ROWS='50'; node --test tests/agent-tool-payload-cap.test.js tests/agent-tools-contract.test.js
ℹ tests 43   ℹ pass 43   ℹ fail 0
```

**Conclusion: the true baseline is 259/259 green with the shipped default cap. No test in the agent
suite is red for a code reason.** This is the line I must not cross at any later phase, and it also
means Phase 1/4/5 must not be blamed on these three.

### Local `.env` agent configuration (values only; no secret is reproduced anywhere in this report)

```
AI_AGENT_ENABLED="true"            AI_AGENT_ALLOW_MUTATIONS="true"
AI_AGENT_PROVIDER_ORDER="gemini,groq"
AI_AGENT_MODEL_PRIMARY="gemini-3.6-flash"
AI_AGENT_MODEL_FALLBACK="openai/gpt-oss-120b"      <-- a GROQ model id
AI_AGENT_MAX_TOOL_CALLS=20         AI_AGENT_MAX_TOOL_RESULT_ROWS=100
AI_AGENT_TURN_TIMEOUT_MS=25000     AI_AGENT_DAILY_TURN_BUDGET=9000     AI_AGENT_ASK_LIMIT=100
```

Two consequences worth knowing before Phase 1/5:

1. `AI_AGENT_MAX_TOOL_CALLS=20` is **silently clamped to 10** by `clampAgentInt(..., 6, 1, 10)`
   (`src/config/env.js:273`). The effective budget is 10, not 20.
2. Because `AI_AGENT_MODEL_FALLBACK` is a Groq id and `PROVIDER_ORDER` names Groq, Phase 5 cannot be
   a code-only change: `.env` must be updated in lock-step or the fallback becomes an id the
   remaining provider cannot serve.

## 3. Verification of the handoff's factual claims (Step 4)

Legend: **CONFIRMED** = matches the code as written; **WRONG** = the code says something else;
**STALE** = was true once, has drifted.

| # | Handoff claim | Verdict | Evidence (file:line at `c51e986`) |
|---|---|---|---|
| 3.1 | Two `hasWriteIntent` gate call sites in `graph.js` (~234 and ~332-335) | **CONFIRMED** | `graph.js:234` (`toolsForTurn`) and `graph.js:332-335` (`selectFor` diagnostic); import at `graph.js:30` |
| 3.1 | `selectToolSet`/`hasWriteIntent` live in `tools/index.js` and their keyword tables feed them | **CONFIRMED** | `selectToolSet` `:229`, `selectDefinitions` `:300`, `hasWriteIntent` `:410`; tables `TOOL_LEXICON` `:133`, `STOPWORDS` `:154`, `TOOL_DESCRIPTION_TOKENS` `:189`, `MAX_SHARED_DESCRIPTION_TOKENS` `:180`, `PHONE_DIGITS_RE` `:186`, `WRITE_VERBS` `:350`, `WRITE_NOUNS` `:362`, `WRITE_SUFFIXES` `:372`, `WRITE_ENABLERS` `:378`, `AMBIGUOUS_WRITE_TOKEN` `:388`, `ACTION_NAMES` `:347` |
| 3.1 | "`listDefinitions()`/`toLangChainTools()` just need to stop being filtered" | **CONFIRMED** | `toLangChainTools` `tools/index.js:565`; the ToolNode already binds the FULL catalogue unfiltered (`graph.js:202-205`) — only the model-facing surface is trimmed |
| 3.3 | `ctx.approved !== true` gate inside `_kit.js` `execute()` | **CONFIRMED** | `tools/_kit.js:275-282`; `throw new AgentToolError('APPROVAL_REQUIRED', …)` at `:277`; the separate attributability check is `:279-281`. Also hard-pinned: `actionTool` sets `requiresApproval: true` (`:88`) and boot validation *requires* it (`tools/index.js:73`) |
| 3.4 | `answerGuard.js` **discards** the answer on a mismatch and throws `GROUNDING_FAILED` | **CONFIRMED** | the block is in the caller: `agentService.js:359-368` returns `{ ok:false, code:'GROUNDING_FAILED', message:'تم تجاهل الإجابة …' }` and persists nothing (baseline test `a fabricated statistic is refused, and nothing is persisted`); `assertGrounded` throws `AnswerGroundingError` (`answerGuard.js:152-156`) |
| 3.4 | "pass the raw question into the guard, which it doesn't currently receive" | **CONFIRMED** | signature is `checkGrounded(answerText, payloads)` (`answerGuard.js:133`); no question text and no tool-call arguments reach it today, so both exemptions are new parameters |
| 3.4 | "a turn where no tool ran is never subject to the check" | **CONFIRMED (not implemented)** | the opposite is implemented: `NO_EVIDENCE_MIN_DIGITS = 1` (`answerGuard.js:42`) makes every integer a claim when there are zero payloads; pinned by `tests/agent-answer-guard.test.js:124-138,159-170` |
| 3.1, §1 | "28-intent router" and "a miss is a dead end" | **CONFIRMED count / STALE on the dead end** | `INTENTS.length === 28` (measured; 27 distinct tools, and **4 read tools have no intent at all**: `student_search`, `db_schema_overview`, `db_schema_detail`, `db_table_stats`). A miss returns `{matched:false, reason:'NO_INTENT'\|'MISSING_SLOT_SLUG'\|'AMBIGUOUS'\|'EMPTY'}` (`router.js:312-348`) and `answerQuestion` **already falls through to the graph** (`agentService.js:284` → `:307-345`). Phase 6 is verification-only — see D4 |
| 3.5 | `llmProvider.js` primary/fallback; "every Groq reference" | **CONFIRMED** | order comes from `config.aiAgent.providerOrder` (`env.js:204` default `['gemini','groq']`, resolved `:228-241`; `primary` = first *configured*). Groq census: `src/config/env.js` x11, `src/services/agent/llmProvider.js` x12, `src/services/agent/tools/index.js` x3, `src/services/agent/graph.js` x1, `package.json` x1, `.env.example` x5, `tests/agent-llm-provider.test.js` x62, `tests/ai-agent-config.test.js` x27, `tests/ai-agent-deps.test.js` x5, `tests/agent-conversation-db.test.js` x1, plus docs (`PROJECT_MAP.md` x3, `API-DOCUMENTATION.md` x1) |
| §1, Phase 1 | "the 22 action tools are hidden unless `hasWriteIntent` AND `AI_AGENT_ALLOW_MUTATIONS`" | **CONFIRMED** | `graph.js:234`: `includeActions = config.aiAgent.allowMutations && hasWriteIntent(question, history)` — one Boolean, both conditions |
| §3.9, Phase 7 | "how `agentService.js` builds the per-turn message list (this is where memory will be injected)" | **WRONG (location)** | `agentService.js` never builds it. `graph.js:268-274` (`agentNode`) does: `[new SystemMessage(SYSTEM_PROMPT), ...compactToolPayloads(state.messages)]`. `SYSTEM_PROMPT` is a module-level **const** (`graph.js:33`), and `agentService` passes only `{ resolveToolContext }` to the factory (`agentService.js:329`) — so 3.2's "assembled at request time" and 3.9's injection both need changes at `graph.js:33` + `:268-274`, not in `agentService.js` |
| §3.6 | "which scheduler triggers `pruneAgentConversations`" | **CONFIRMED** | not a central scheduler. `app.js:452-456` (inside the agent-enabled boot block) requires and calls `startRetentionJob()`, which registers its own `node-cron` `'17 3 * * *'` (`src/jobs/pruneAgentConversations.js:105`); stopped from the shutdown hook at `app.js:537`. A sibling job must reuse *this* entry point |
| §3.6 | `AgentApproval` needs no column changes (`argsHash`,`status`,`expiresAt`,`consumedAt`,`decidedBy`,`decidedAt`) | **CONFIRMED** | `prisma/schema.prisma:540-561`; status enum `PENDING\|APPROVED\|REJECTED\|EXPIRED\|CONSUMED` (`:524-530`) |
| §3.6 | `AgentMemory` and `User.deletedAt`/`Course.deletedAt` are missing today | **CONFIRMED** | no `AgentMemory` anywhere; `grep -n 'deletedAt' prisma/schema.prisma` → 0 hits |

| §3.8 | conversation list/open/rename/delete/auto-title exist; search + regenerate do not | **CONFIRMED (with a caveat)** | `conversationService.js` exports `buildTitle`, `getOrCreateConversation`, `createConversationWithTurn`, `appendMessage`, `recordTurn`, `listConversations`, `getMessages`, `pruneExpiredConversations`; routes are `POST /ask`, `GET /conversations`, `GET /conversations/:id/messages` + the approval trio (`agentRoutes.js:80,130,141,161,183,202`). **No rename and no delete route exists** — see D2 |
| §1 | "53-tool inventory (31 read, 22 action)" | **CONFIRMED exactly** | measured by requiring the registry: `reads=31 actions=22 total=53` |
| §1 | retention wired to `AI_AGENT_CONVERSATION_RETENTION_DAYS` | **CONFIRMED** | `env.js:291` clamps to 30 (7..3650); `pruneAgentConversations.js:65` reads `config.aiAgent.conversationRetentionDays` |
| §3.2/§3.3, §0 rule 6 | "`app.js:330-345` agent mount doctrine unchanged" | **CONFIRMED** | `app.js:333-346` — mounted only when `config.aiAgent.enabled`, else one explanatory log line and nothing mounted |
| §4 Phase 1 | "`AI_AGENT_ALLOW_MUTATIONS` defaults to false" | **CONFIRMED (code) — already `true` in `.env`** | default `false` at `env.js:251`; local `.env` already sets it `true`, so Phase 1's `.env` step is a no-op locally and a real change on staging |
| §3.5 | `@langchain/google-genai` already a dependency at `2.3.1` | **CONFIRMED** | `package.json:29`; `@langchain/groq` at `:30` |
| §3.5 | ids `gemini-3.7-flash` (primary) / `gemini-3.6-flash` (fallback) are live | **PARTLY CONFIRMED — see D5** | both exist on this key and both emit real tool calls; `gemini-3.7-flash` answered `503 UNAVAILABLE "high demand"` on 2 of 3 probes |
| §3.5 | `gemini-3.8-flash` "is not yet listed in Google's own public model catalog" | **WRONG** | `GET /v1beta/models` on this key lists `gemini-3.8-flash` (also `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`; 50 models total) |
| §3.7 | `initAgentSocket` attaches to the already-listening HTTP server | **CONFIRMED** | `socketHandler.js:226-243` (`initAgentSocket(httpServer)`), called from the `server.listen` callback in `app.js`; `SOCKET_PATH = '/agent-ws'` |

### Live model probes (`gemini-3.*` on this project's `GEMINI_API_KEY`)

Minimal `generateContent` with one declared function and `functionCallingConfig.mode = ANY`:

```
gemini-3.7-flash -> attempt1 HTTP 503 UNAVAILABLE (high demand)
                    attempt2 HTTP 200 toolCall=ping
gemini-3.6-flash -> attempt1 HTTP 200 toolCall=ping
                    attempt2 HTTP 200 toolCall=ping
gemini-3.8-flash -> HTTP 503 UNAVAILABLE (high demand)
```

Model-list probe: 50 models; `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.6-flash`,
`gemini-3.7-flash`, `gemini-3.8-flash`, `gemini-3.1-pro-preview`, `gemini-3-pro-image`, … all present.

### Measured tool-surface cost (the number the handoff estimated as "6-8k tokens")

Using the repo's own `approximateSchemaTokens` proxy (name + description + field names, chars/4) and
the real model-facing JSON (`z.toJSONSchema`, i.e. what `stripUnsupportedSchemaKeys` hands the provider):

```
proxy        : reads-only 10,208 chars (~2,552 tok)   |  all 53  16,562 chars (~4,141 tok)
model-facing : reads-only 21,163 chars (~5,291 tok)   |  all 53  37,879 chars (~9,470 tok)
```

So the model-facing payload for the **full** catalogue is ~9.5k tokens **per model call**, and the
current per-turn shortlist is ~5.3k tokens for the read half only. With `maxToolCalls` effectively 10,
one turn can re-send that surface up to 11 times.

### Arabic / encoding / line endings (Stage-2 rule 7)

- Whole `src/services/agent` tree + `agentRoutes.js` + `tests/*.js`: **CRLF**.
- **Exactly one file carries a UTF-8 BOM: `src/services/agent/tools/index.js`** (verified by byte
  scan of 25 agent files). Edits to it must not strip the BOM; run
  `git diff --stat` after each phase as the handoff requires.
- `app.js` is CRLF (the handoff says so — CONFIRMED).
- Note for tooling: the plain `Get-Content` line counts for these files are unreliable; the numbered
  reads (authoritative) show `tools/actions.js` extends past line 1436.

## 4. Discrepancies between the handoff and the code

**D1 — `confirmationToken: z.string().uuid()` cannot be satisfied by "no column changes" (BLOCKER).**
§3.3 says the preview returns "the new row's id as `confirmationToken`" and that `AgentApproval` needs
no column changes — but `AgentApproval.id` is `Int @id @default(autoincrement())`
(`prisma/schema.prisma:541`), which can never be a UUID. Two ways out: (a) token = the row id as a
string, schema `z.string().regex(/^\d+$/)`; (b) add `token String @unique @default(uuid())` to
`AgentApproval` + a migration. **Proposal — default (a)**: no schema change, matches "no column
changes", and the token is still an ownership-checked handle whose real guard is the
adminId + status + expiry + argsHash check, not token entropy. **Blocking question (Q1).**

**D2 — Decision #14 says conversation *rename* and *delete* already "exist"; they do not.**
`conversationService.js` implements list/create/append/record/prune and `agentRoutes.js` exposes only
`POST /ask`, `GET /conversations`, `GET /conversations/:id/messages` (+ the approval trio). There is
**no rename route and no delete route** — so "list, open, rename, delete, auto-titles (exist) + search
+ regenerate" describes a v1 in which two of the six named features have no backend at all, and no
phase adds them. **Proposal:** Phase 9 implements exactly the two routes it names (search + regenerate)
and I report rename/delete as a gap rather than silently inventing two endpoints (§5 scope boundary +
§0 rule 4). **Sign-off request (Q7).**

**D3 — `create_video` already exists as an action tool, while Decision #18 forbids video creation via chat.**
The catalogue contains `create_video` (audit `VIDEO_CREATE`, target `video`) — it creates the
`BunnyVideo` row; the binary upload stays on `POST /videos/:videoId/upload`, untouched by chat. Once
Phase 1 binds all actions every turn, the model will be able to create a video through chat, which
reads as a direct conflict with "No `create_video`/upload flow through chat". **Proposal:** leave the
tool exactly as it is (it is audited and already shipped; §5 forbids *adding* tooling, not keeping it)
and read Decision #18 as "no UPLOAD flow through chat". If the owner means "chat must not be able to
create a video at all", that is a removal the handoff never authorises. **Sign-off request (Q6).**

**D4 — Phase 6 ("fast path must not be a dead end") is already satisfied structurally.**
`answerQuestion` runs the deterministic tier first and only then the model
(`agentService.js:279-305` → `:307-345`); a decline is a routing decision, never an error
(`engine.js:67-75`). So Phase 6 is a *verification-only* pass, as §4 allows. The one genuine gap is in
§3.5's outage wording: a total provider failure maps to `LLM_UNAVAILABLE` (via `ALL_PROVIDERS_FAILED`)
or `LLM_ERROR` (`agentService.js:339`), not to the `PROVIDER_UNAVAILABLE` code the handoff wants; and
"first attempt the fast-path router against the same question" is already automatic because the fast
path ran *before* the model. **Proposal:** implement the typed code (`PROVIDER_UNAVAILABLE` for the
all-providers-failed class) and do **not** reorder anything; report the rest as already-correct.

**D5 — the `gemini-3.8-flash` justification is factually wrong, and 3.7-flash is intermittently 503.**
The handoff says 3.8 is "callable but not yet listed in Google's own public model catalog"; on this key
`GET /v1beta/models` lists it, and `gemini-3.7-flash` too. The decision to use 3.7/3.6 is fine to keep,
but its stated reason does not hold, and my probe shows 3.7 returning `503 UNAVAILABLE (high demand)`
on 2 of 3 attempts while 3.6 answered 3/3. **Proposal:** implement 3.7 primary / 3.6 fallback exactly
as specified (llmProvider already classifies 503 as *transient* with a 60s cooldown, so a 3.7 503 fails
over and the turn still completes), and record the probe in the Phase 5 report. **Sign-off request (Q4).**

**D6 — §3.1's token sanity check understates the cost, and its reasoning targets the wrong limit.**
Measured model-facing payload: **~9.5k tokens for all 53 tools** per model call (not 6-8k), re-sent on
every step of the loop (effective `maxToolCalls` = 10, once the `.env` value of 20 is clamped), plus the
conversation history and a memory block. The claim "Gemini Flash's context window is 1M tokens; this is
not a real constraint" is true about *context* and irrelevant to *per-minute quota* — and this very repo
has a recorded incident where a free-tier tokens-per-minute ceiling made the agent tier structurally
dead (`PROJECT_MAP.md`, Phase 4.5: Groq 8k TPM against ~7k of schema per call). **Proposal:** implement
Decision #15 as written (bind everything, do not pre-optimise) **and** record the measured per-turn
token cost in the turn's audit metadata so the revisit trigger is data, not opinion. **Sign-off request (Q3).**

**D7 — `requiresApproval` metadata vs Decision #1.**
`actionTool()` hardcodes `requiresApproval: true` (`_kit.js:88`), boot validation *requires* it for
every action (`tools/index.js:73`), and two suites assert it
(`tests/agent-tools-contract.test.js:134`, `tests/agent-actions-crud.test.js:184`). Removing the
`approved` check from `execute()` (Decision #1) does not require touching any of that. **Proposal: leave
the flag and the validation exactly as they are** — it stays truthful for the 5 confirm-kind tools and
is inert metadata for the rest — so Phase 3 changes only what it names. Flagged as an assumption, folded
into Q2.

**D8 — soft-delete does not revoke a live session, and `authenticateToken` never touches the database.**
`authenticateToken` (`middlewares/index.js:10-34`) only verifies the JWT signature/type — no DB read.
Today's hard `delete_user` also removes the user's enrollments, so access dies immediately. A Phase 8
soft delete that only sets `User.deletedAt` leaves **enrollments intact and the access token valid for
up to 15 minutes**, so a "deleted" student keeps streaming videos (and could even refresh, depending on
whether the refresh lookup filters `deletedAt`). **Proposal:** `delete_user`'s soft-delete additionally
clears `refreshToken`/`refreshTokenFamily` (one reversible field write, no new machinery) and Phase 8
adds `deletedAt: null` to the refresh-token lookup; I will NOT add a DB read to `authenticateToken`
(a hot-path change no phase authorises). **Sign-off request (Q2).**

**D9 — §3.9's memory cap is a per-call cost that is budgeted nowhere.**
"Inject the admin's most recent `AgentMemory` rows (capped, start at 50)" at the schema's own
`max(500)` chars is up to ~25k chars ≈ 6.3k tokens **per model call**, on top of D6's 9.5k of tool
schema. **Proposal:** ship the cap as a config value using the handoff's default of 50, and record the
measured block size in the Phase 7 report so the number is reviewable rather than implicit.

**D10 — Phase 8's blast radius, enumerated (the input to that phase's grep pass).**
`prisma.user.*` / `prisma.course.*` reads in `src/` (excluding `scripts/`, which is not a runtime
path): `config/setupAdmin.js:13`; `controllers/adminController.js:71,72,73,80,102`;
`controllers/assignmentController.js:818`; `controllers/authController.js:40,115,118,199`;
`controllers/bunnyVideoController.js:434`; `controllers/coursesController.js:56,72,116,136,257,309,362`;
`controllers/enrollmentController.js:38,133,189,198,278,284`; `controllers/quizController.js:1003`;
`controllers/searchController.js:145,294,379,437`;
`controllers/userController.js:24,57,86,102,176,252,296,303`;
`controllers/videoProgressController.js:179`; `middlewares/index.js:131,165`;
`services/agent/socketHandler.js:80`; `services/agent/tools/actions.js:44,51,660,690,741,743,1259,1366,1379`;
`services/agent/tools/courses.js:58,116,176,244,382`; `services/agent/tools/enrollments.js:73,170`;
`services/agent/tools/platform.js:52,53,54,66,110`; `services/agent/tools/students.js:58,95,141,183,281`;
`services/bunnyVideoService.js:135,574,642`; `services/notifications/notificationService.js:70,76,83`;
`services/payments/paymentService.js:132,152`. Four of these are *deliberately* different from the rest:
`authController.js:40` (login — must still find the row, then reject as deleted), `:115/:118` (register
uniqueness — must not silently release a deleted user's email), `:199` (refresh — must reject a deleted
user), and `middlewares/index.js:131/165` (role/isAdmin, admin-only paths). **Proposal:** nothing here is
mine to decide now; Phase 8 will re-grep and I will list every touched line in its report. The
email/phone uniqueness question is Q5.

## 5. Risks in the phases, ranked

You expected Phase 3 and Phase 8 at the top. **I agree on both, and I put Phase 1 third on measured
evidence** (it is described as a mechanical removal, and it is not).

### R1 — Phase 3 (delete/broadcast two-step; remove the approval gate) — HIGHEST
Three separate hazards in one phase, all on the only surface that can destroy data:

1. **It removes the strongest guard in the module.** `ctx.approved !== true` (`_kit.js:275-282`) is the
   single check standing between a model turn and an unattended mutation; the approval is
   *server-resolved* and never model-supplied (`graph.js:12-15`, `agentService.js:104-128`). Replacing
   "every action needs a consumed, args-bound human approval" with "21 of 22 actions need nothing, 5
   need a self-issued in-chat token" is a net reduction in defence unless the token check is exactly
   right. The handoff knows this ("a real server-side guard, not a prompt instruction") — the work is
   proving it with the bypass tests it lists.
2. **The confirm flow has an unresolved type contradiction (D1)** and no decision about the now-vestigial
   HITL surface (`POST /approvals`, `/approvals/:id/decide`, `GET /approvals/:id`, the socket
   `agent:decide` handler, `findRefusedMutation` + `approvalRequested` in `agentService.js:45-65,370-391`).
   Left alone they still *look* authoritative; removed they are a scope expansion. Either way it must be
   stated, not discovered.
3. **`broadcast_notification` is in the confirm list but is not destructive** — it is high-blast-radius
   (Decision #9: always confirm, regardless of audience size), which is fine, but it means the
   preview/confirm builder must handle a non-delete verb whose "preview" is a *recipient count*, not a
   row. §3.3's wording is delete-shaped.

**Mitigation:** implement the token check first and prove the refusals (`EXPIRED`/`CONSUMED`/args
mismatch/foreign admin) before removing the `approved` check, so there is never a commit in which both
guards are absent. The inner order of the phase matters even though the phase list reads as one step.

### R2 — Phase 8 (soft delete across six domains) — HIGH
Not because soft delete is hard, but because of the blast radius enumerated in D10 (~90 call sites in
`src/`) and because **a missed `where: { deletedAt: null }` fails silently and open**: the deleted
student/course simply reappears, and no test in the suite today would notice. Sharper hazards found
while reading:
- `authenticateToken` has **no DB read at all** (`middlewares/index.js:10-34`), so a soft-deleted user
  keeps a working session (D8). "must not resurface in … auth" cannot be true without either revoking
  refresh tokens at delete time or adding a read to a hot path.
- `User.email`/`User.phoneNumber` are `@unique` (`schema.prisma:15,16`), so a soft-deleted student keeps
  their identifiers occupied for 30 days; `create_student` (`actions.js:741-743`) and register
  (`authController.js:115-118`) will report "taken". Decision #19 does not cover re-registration (Q5).
- `Course.teacherId` is a required FK (`schema.prisma:49-50`) and the existing `delete_user` refuses
  course owners (`actions.js:1379-1382`); soft delete must decide whether that refusal survives.
- `@@unique([userId, courseId])` on `Enrollment` is untouched by soft delete, so a soft-deleted (then
  accidentally restored) user still holds enrollments and gate verdicts — probably intended, but it is a
  behaviour change vs today's hard delete and should be written down.

### R3 — Phase 1 (tool exposure) — MEDIUM-HIGH, and the handoff rates it as low
It is the phase the whole rebuild's premise rests on, and the one whose cost I could actually measure.
Binding everything raises the model-facing surface from ~5.3k to ~9.5k tokens **per model call**, on
every step of the loop (D6). If the Gemini free tier's per-minute ceiling bites, the symptom is exactly
the historical one — the tier answers without calling a tool, or 429s — and the failure will be blamed
on the prompt, not the surface. Secondary: Phase 1 deletes the code that the tip commit `c51e986` was
*entirely about* (the Egyptian-dialect `WRITE_VERBS` and the `student_search` phone boost live inside
`selectToolSet`/`hasWriteIntent`), and it necessarily breaks assertions in four suites
(`agent-actions-intent` wholesale; `agent-graph` "SHORT tool surface" `:199-216`; `agent-schema-tools`
"a schema question selects the schema tools" `:223-231`; `agent-tools-contract` `:421-429,519-533`).
Those deletions must be stated as "the behaviour this test existed to protect is gone by decision",
which the handoff permits — but it is a judgement call per test, not a sweep. **Mitigation:** keep the
token measurement in the phase report; note that with everything bound, `student_search` and the three
`db_schema_*` tools stop being special-cased (they were the 4 read tools with no fast-path intent).

### R4 — Phase 5 (Gemini-only) — MEDIUM
Mechanical in the code, but env-coupled: `.env` sets `AI_AGENT_PROVIDER_ORDER="gemini,groq"` and
`AI_AGENT_MODEL_FALLBACK="openai/gpt-oss-120b"`, so code and local/staging config must move together or
the fallback is a dead id. The test blast radius is real (62 + 27 + 5 Groq references across three
suites, by census) and "remove the fixtures rather than leave them skipped" is the right instruction —
but `tests/agent-llm-provider.test.js` uses Groq *as the primary in the failover fixtures*, so those
cases must be re-expressed as two *models of the same provider*, not merely deleted. Also note Phase 5's
target behaviour (`PROVIDER_UNAVAILABLE` after the fast path) is partly already implemented (D4).

### R5 — Phase 4 (grounding: warn, never block) — MEDIUM (product risk, low code risk)
The code change is small and the tests invert cleanly. The risk is that this guard is currently the only
mechanical defence against a fluent fabricated statistic, and Decision #13 removes its teeth. Two
specific subtleties: (a) the *no-evidence* rule (`NO_EVIDENCE_MIN_DIGITS = 1`) is the part that caught a
real production failure — a failover turn answering "there are 3 students" with `tools: []` — and Phase
4 says skip the check entirely on tool-free turns, which removes the catch, not just the block; (b) the
new exemptions need the raw question and the tool-call arguments threaded into the guard, which today
receives neither.

### R6 — Phase 7 (memory) — LOW-MEDIUM
New model + three tools + injection + a cloned prune job; well-specified. The only new risks are cost
(D9) and the fact that the injection point is `graph.js` `agentNode`, not `agentService` (the WRONG row
in §3).

### R7 — Phase 10 (full regression + staging) — LOW-MEDIUM
The suite is green today (259/259 with the cap pinned) and fast enough (150s for the agent files alone).
The two live hazards: the shared staging Supabase (writes are real — `npm test` is described as net-zero
but Phase 8's soft-deleted rows are *not* self-cleaning by design), and the manual staging script needing
`AI_AGENT_ENABLED` / `AI_AGENT_ALLOW_MUTATIONS` / model ids set on Railway, which is outside my reach.

**Phases 2, 6, 9 — LOW.** Phase 2 is a prompt swap whose only test fallout is literal-string assertions;
Phase 6 is verification-only (D4); Phase 9 is two additive routes behind the existing auth middleware.

## 6. Questions — one batch, each with my recommended default

Only **Q1** is a true blocker (Section 2 contradicts itself, and §0 rule 1 says stop rather than pick a
side). For **Q2-Q7** I have named the narrowest, safest default, which I will implement and flag as
"assumption made — needs sign-off" unless you tell me otherwise; none of them changes the shape of the
rebuild.

**Q1 (BLOCKER) — what is `confirmationToken`?** §3.3 specifies `z.string().uuid()` **and** "the new
row's id" **and** "no column changes to `AgentApproval`" — three statements that cannot all hold, since
`AgentApproval.id` is an autoincrement `Int`. Which do you want?
**Recommended default: the row id as a decimal string** (`z.string().regex(/^\d+$/)`), no migration to
the approval table. The security property does not come from the token's entropy but from the
server-side checks (owner, `PENDING`, unexpired, unconsumed, args-hash match), all of which I will test
with bypass attempts. **Alternative:** a real `token String @unique @default(uuid())` column, which
costs one additive migration and keeps the literal `uuid()` schema.

**Q2 — what happens to the old HITL surface when the approval gate is removed?** After Phase 3,
`POST /admin/agent/approvals`, `GET /approvals/:id`, `POST /approvals/:id/decide`, the socket
`agent:decide` event, `findRefusedMutation`, `approvalRequested`, and `requiresApproval: true` on every
action all become inert (D7).
**Recommended default: leave all of them in place and report them as "noticed, not touched"** — no
phase names them for removal, deleting them would break `tests/agent-rest.test.js` and
`tests/agent-approvals-db.test.js` (which are not on my deletion list), and an inert-but-working
endpoint is easier to reverse than a deleted one. I will NOT repurpose `AgentApproval` for anything
except the confirm tokens §3.3 specifies.
Sub-question: should the *prompt* keep telling the model that approval is pending ("النظام يطلب موافقة
المشرف تلقائياً…")? Phase 2's replacement text does not mention it, which is correct for Decision #1 —
confirming that is part of this answer.

**Q3 — Phase 1 bind-all: as written, or bind-all + instrumentation?** Measured cost of Decision #15 is
~9.5k tokens of tool schema per model call (up to 11 calls/turn), against ~5.3k today (D6).
**Recommended default: implement Decision #15 exactly as written (all tools, every turn, no pre-emptive
grouping) and add a per-turn token measurement to the existing audit metadata**, so the "revisit only if
measured in practice" trigger has data the moment it matters. No behaviour change, no new config, no new
tool.

**Q4 — model order, given the measured 503s?** `gemini-3.7-flash` failed with
`503 UNAVAILABLE (high demand)` on 2 of 3 probes; `gemini-3.6-flash` succeeded 3/3 with real tool calls.
**Recommended default: keep the handoff's order (3.7 primary, 3.6 fallback)** — `classifyFailure` already
treats 503 as *transient*, `FAILOVER_COOLDOWN_MS` (60s) skips a flapping primary, and the turn still
completes on the fallback. I will record the probe output in `PHASE_5_REPORT.md`. **Alternative:** make
the currently-stable 3.6 the primary and 3.7 the fallback (one env default, no logic change).

**Q5 — soft delete vs `@unique` email/phone, and session revocation on `delete_user` (D8/D10).** A
soft-deleted student keeps their unique `email`/`phoneNumber` for 30 days, so re-registering the same
person fails with "already in use", and their existing access token keeps working for up to 15 minutes
because `authenticateToken` never reads the database.
**Recommended default: (a) leave the unique constraints alone and do NOT rewrite identifiers on soft
delete** (rewriting them corrupts the audit trail and makes a restore lossy); (b) have `delete_user`'s
soft delete also clear `refreshToken` + `refreshTokenFamily` (the same "kill the session" outcome the
current hard delete achieves by removing enrollments); (c) add `deletedAt: null` to the refresh-token
lookup; (d) do **not** add a DB read to `authenticateToken`. The 15-minute window is then the only
residual, and I will state it in the Phase 8 report rather than hide it.

**Q6 — `create_video` remains in the catalogue (D3).** Decision #18 says no video *creation* via chat,
but the tool ships today and Phase 1 will expose it on every turn.
**Recommended default: keep the tool unchanged** (it is audited, it only creates the DB row, and the
binary upload stays on the untouched HTTP route), reading Decision #18 as "no upload flow through chat".
**Alternative:** remove `create_video` from the action catalogue (a deletion no phase authorises, and it
would break the catalogue-contract test in `tests/agent-actions-crud.test.js`).

**Q7 — conversation rename/delete have no backend (D2).** Decision #14 lists them as existing; they do
not, and no phase adds them.
**Recommended default: Phase 9 adds only `GET /conversations/search` and
`POST /conversations/:id/regenerate`** (exactly what the phase names) and I report rename/delete as a gap
in `PHASE_9_REPORT.md` under "Noticed, not touched". **Alternative:** also add
`PATCH /conversations/:id` (title) and `DELETE /conversations/:id` — small and additive, it makes
Decision #14 true, but it is scope beyond the phase text.

## 7. Stage-1 method (what I ran, so it can be re-run)

- **Read (whole file, or the ranges the claim needed):** all 23 files under `src/services/agent/`
  (`agentService`, `answerGuard`, `approvals`, `conversationService`, `engine`, `graph`, `limits`,
  `llmProvider`, `pii`, `router`, `socketHandler`, `toolCache`, and
  `tools/{index,_kit,actions,platform}`), `src/routes/agentRoutes.js`, the agent block of `app.js`
  (300-560), `resolveAiAgent` in `src/config/env.js` (170-300), the agent models in
  `prisma/schema.prisma` (12-70, 480-565), `src/jobs/pruneAgentConversations.js`,
  `src/middlewares/index.js` (auth + role paths), `src/controllers/authController.js` (login/refresh),
  and the tests `agent-graph`, `agent-actions-crud`, `agent-actions-intent`, `agent-answer-guard`,
  `agent-approvals-db`, `agent-rest`, `agent-service-db`, `agent-schema-tools`, `agent-tools-contract`,
  `agent-llm-provider`, `ai-agent-deps`, `ai-agent-config`.
- **Measured, not assumed:** tool counts (`31 + 22 = 53`), intent count (`28`, with 4 read tools
  uncovered), the token cost of the model-facing surface (both the repo's own proxy and the real
  `z.toJSONSchema` payload), the Groq reference census, a BOM/CRLF scan of every agent file, the live
  Gemini model list plus per-model function-calling probes, and the full 22-file baseline run.
- **Repeatable commands:**
  - baseline / per-phase: start the server as `PORT=3106 NODE_ENV=development node app.js`, then
    `TEST_BASE_URL=http://127.0.0.1:3106 node --test --test-concurrency=1 tests/agent-*.test.js tests/ai-agent-*.test.js`
    (the `test:direct` shape; the repo's `npm test` runs *all* suites with no filter).
  - catalogue facts: `node -e "const t=require('./src/services/agent/tools'); console.log(t.readDefinitions.length, t.actionDefinitions.length)"`.
  - token cost: same module + `z.toJSONSchema` over each definition, `JSON.stringify({name,description,parameters})`.
- **Not touched:** no repository file was created, modified or deleted except this report. The only
  processes I started (a test server on port 3106 and two short-lived probe scripts under `%TEMP%`) were
  stopped; `git status` shows no change to any tracked file and nothing was committed.

**Status: Stage 1 complete. I am stopping here. I will not start Phase 0 or make any code change until
you reply with "GO"** — and if you answer Q1, I will fold the answer into the Phase 3 plan before writing
any code.

