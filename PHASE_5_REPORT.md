# PHASE_5_REPORT.md

## 1. Goal

Gemini-only provider (handoff §3.5, Decision #2): remove the second vendor everywhere it appears —
code, config, model defaults, docs, dependency — collapse failover onto the two Flash-tier model ids
served by the one vendor, and wire the outage path to try the fast-path router once before failing as
`PROVIDER_UNAVAILABLE` (Decision #17).

| Requirement | Status |
|---|---|
| Groq branches + `@langchain/groq` import gone from `llmProvider.js` | Done, verified by the phase DoD grep |
| primary = `AI_AGENT_MODEL_PRIMARY`, fallback = `AI_AGENT_MODEL_FALLBACK`, both via `@langchain/google-genai` | Done — as two ATTEMPTS on one vendor (see §3) |
| model ids verified live on the project's key (the §3.5 precondition) | Done — the catalogue list names both |
| `@langchain/groq` removed from `package.json` (+ lock) | Done, verified `npm ls` fails |
| `.env.example` per §3.5 | Done — no `GROQ_API_KEY`, Flash-tier ids in place |
| outage: fast-path attempted once, then typed `PROVIDER_UNAVAILABLE`, no silent retries | Done, pinned at both layers with call counts |
| Groq fixtures/mocks removed from `agent-llm-provider.test.js`, `ai-agent-deps.test.js` | Done — no dead skipped tests left |

## 2. Files changed

```
 src/services/agent/llmProvider.js      |  vendor-level failover -> attempt-level (two Gemini
                                           ids); createModel(name, modelId); state keyed by
                                           vendor:model; model in the outcome; healthState per
                                           attempt; modelIdFor deleted
 src/config/env.js                      |  providers map = { gemini }, default order ['gemini'],
                                           model defaults 3.7/3.6, Groq key gone
 src/services/agent/agentService.js     |  run.model recorded; outage -> fast-path last chance
                                           -> PROVIDER_UNAVAILABLE; LLM_UNAVAILABLE deleted;
                                           answerFactory seam
 src/services/agent/tools/index.js      |  one stale "second vendor tolerated it" comment fixed
 package.json + package-lock.json       |  @langchain/groq removed (26 deletions)
 .env.example                           |  no GROQ_API_KEY, Gemini-only block + ids
 tests/agent-llm-provider.test.js       |  rewritten for the single vendor (18 tests)
 tests/ai-agent-deps.test.js            |  absence-of-vendor pin + sole-provider pin
 tests/ai-agent-config.test.js          |  single-vendor fixtures + id pins
 tests/agent-service-db.test.js         |  three outage-contract tests
 PHASE_5_REPORT.md                      |  this file
```

## 3. What changed, precisely

### The failover's new shape

With one vendor left, "primary/fallback by provider name" cannot exist. The failover walks
`failoverTargets()`: one entry per `(vendor, model id)` — in this deployment,
`gemini:gemini-3.7-flash` then `gemini:gemini-3.6-flash` — with duplicate ids collapsed so a

## 4. Verification (measured, not asserted)

| Run | Result |
|---|---|
| `grep -r "groq\|Groq" src/services/agent` | **empty** (first DoD — comments included) |
| `npm ls @langchain/groq` | **exit 1, `-- (empty)`** (second DoD — genuinely removed, not unused) |
| `tests/agent-llm-provider.test.js` (rewritten, 18) | **18/18 pass** |
| provider + contract + config/dep batch | **31/31 pass** |
| `tests/agent-service-db.test.js` (real DB) | **13/13 pass** (incl. the three outage-contract tests) |
| full agent suite (`agent-*` + `ai-agent-*`, cap pinned, live server) | **264/264 pass, 0 fail** |
| `RUN_LIVE_AGENT=1 node scripts/smoke-agent.js` | **8/8 pass, 0 warn, net-zero**, incl. a real model-tier turn (`source=llm provider=gemini`) |
| `eslint .` repo-wide | clean (exit 0) |
| model-id precondition (§3.5): the vendor catalogue listed on THIS key | both ids present (see §5) |

264 vs the Phase 4 count of 260: +3 outage-contract tests (service-db) and +1 attempt-list pin
(provider file). The row-cap pin is an environment override, never a code change (Phase 0 doctrine).

### 4.1 The one structural addition, flagged (Section 0 rule 4)

`answerFactory` is a new `answerQuestion` option, mirroring the existing `graphFactory` seam. It is the
test seam the §3.5 outage case needs: "the fast path was consulted again" is only assertable by counting
those calls. It decides nothing and changes no default — `= answerDeterministic` preserves the shipped
call site exactly. Sign-off welcome; deletion-safe (the turn handler would work, the test would not).

`primaryModel === fallbackModel` config makes ONE attempt instead of retrying the identical
request. Cooldown and the unusable set are keyed per attempt for the same reason: a vendor-level
key would let a retired primary id disable the healthy fallback riding the same vendor name.
`invokeWithFailover` returns `{ result, provider, model, attempts }`; `agentService` records
`run.model` directly and no longer re-derives which id answered from config.

### The outage path (Decision #17)

`agentService` no longer answers `LLM_UNAVAILABLE` — that code is deleted. A provider-outage
(`ALL_PROVIDERS_FAILED`) gets ONE deterministic re-check of the fast path against the same question
(no model, no retry loop), then fails as `PROVIDER_UNAVAILABLE` with a plain dialect message and no
retry evidence hiding anywhere. Anything else (bad key, malformed request) answers `LLM_ERROR` and
never re-consults the fast path. In today's tier order the re-check is a second look the
deterministic router can only decline (declining is exactly why the turn reached the model), so it
is inert-but-guaranteed: the code keeps the decision true even if the tier order ever changes.

### What stayed untouched by design

`classifyFailure` (including the third `provider_config` class), the cooldown constant, the
`healthState` key names, `ALL_PROVIDERS_FAILED` as the one tier-down code, the turn handler's
pre-LLM deterministic tier, and all seven safety mechanisms the handoff says to keep. A bad key
still must not spend the second attempt; cooldown still skips only the primary attempt; a retired
id still warns once and is never re-probed.

## 5. Anything unexpected

- **The outage tests exposed the fixture, not the code.** My first stubs threw the outage from the
  `graphFactory` itself, but the factory is *invoked before* the try block that maps provider failures —
  so the error escaped as an unhandled rejection instead of routing to `PROVIDER_UNAVAILABLE`. The fix
  (a graph-like stub whose `invoke` throws) mirrors exactly where a real outage surfaces, and the failing
  first version is why the call-count assertion matters: it proves the second look ran, not just that the
  final code is right.
- **`AI_AGENT_MODEL_PRIMARY` in `.env.example` was already stale.** It pinned the old Groq id while
  `env.js` shipped a Gemini default — a verbatim copy of the example produced a cross-vendor mismatch.
  This round rewrites the whole block, and the new config test pins that the defaults are distinct ids
  (an equal pair would make the fallback a silent copy).
- **The catalogue lists `gemini-3.8-flash` too.** The handoff's hold is based on the *public* catalog, so
  3.7/3.6 ship as decided — but the live list naming 3.8 is the first half of the reassess trigger, and
  it is recorded here for the owner.
- **`gsk_…` scrubbing stays.** A key-shape scrub, not a vendor branch, kept because a pasted key of the
  wrong shape is exactly what it makes harmless. Nothing in the DoD grep matches it.
- **`createModel('groq')` appears in exactly one place — the tombstone test** proving it throws
  `UNKNOWN_PROVIDER`. That is the DoD's most literal pin: the vendor cannot be constructed, so no
  lazily-required call site can reach it. A tombstone assertion, not a fixture.


## 6. Deviations from the phase prompt

- **`AI_AGENT_PROVIDER_ORDER` survives but is inert.** §3.5 never mentions it; deleting an env var is a
  wider blast radius than removing a vendor (deploys set it), so the mechanism stays — unknown names still
  drop, the filter cannot invent a provider — with a comment saying it can no longer change anything.
  Deleting the var is a one-line follow-up once staging confirms nothing reads it.
- **No Pro escalation, no paid tier, no new tools, no frontend work** — as §5 requires. The only new
  function is `failoverTargets()` and the only new option is the test seam.
- The `PROVIDER_UNAVAILABLE` copy is longer than "a plain typed error" suggests — one sentence naming the
  cause, one naming the remedy — because Phase 4's own lesson is that an unwarned failure teaches nothing.

## 7. What the next phase must know

- **Phase 6 (fast-path fallthrough) has ONE new wrinkle from this phase:** the outage path consults the
  fast path a second time, so the router's contract ("never the only path, never a dead end") must hold
  for calls from BOTH sites. The understanding report already found that `answerQuestion` falls through to
  the graph on a decline — re-confirm it now that the router has two callers in one turn.
- **`LLM_UNAVAILABLE` is dead; `PROVIDER_UNAVAILABLE` + `LLM_ERROR` are the two outage facts.** Dashboards,
  socket listeners, and FE branches matching the old code must be updated — `API-DOCUMENTATION.md` still
  lists the old trio (§557/630/682), which is an owner-side doc edit outside this phase's file scope.
- **`detail.model` is new on the answer payload** (the answering id, straight from the failover). The FE
  console can render it for free; nothing old was removed.
- **The R5 sign-off from Phase 4 got neither better nor worse** — a model-level failover does not make a
  model more honest. Say so again in the Phase 6 brief if it comes up: this phase changed *who* answers,
  not what a fabricated number costs.
- Do not re-add a vendor without deleting the attempt-dedupe assumption: `failoverTargets()` collapses
  identical ids on purpose, so a second vendor configured with the SAME id as the first would get one
  attempt, not two. Correct today, a trap the moment it is not.

