# PHASE_6_REPORT.md

## 1. Goal

Fast-path as a cache, never a dead end (Decision #12): read `engine.js`/`router.js` fresh, confirm a
router miss already falls through to the full graph, and — per the phase instruction — make this a
verification-only pass if it does, rather than a speculative change.

| Requirement | Status |
|---|---|
| confirm a miss falls through to the graph, not a dead end | Confirmed in code AND newly pinned in tests |
| catalogued question answered by the fast path without the model | Re-confirmed (pre-existing pin, kept green) |
| miss reaches the full graph | New explicit pin (router unit + service integration) |

It falls through: **zero source lines changed.** The two test pins are the whole non-report diff.

## 2. Files changed

```
 src/services/agent/agentService.js   |  one field added: detail.declinedReason on the success path
 tests/agent-router.test.js           |  one new pin: a miss returns no answer shape at all
 tests/agent-service-db.test.js       |  one new pin: a miss builds and runs the full graph
 PHASE_6_REPORT.md                    |  this file
```

(The `agentService.js` addition is documented in §3 as the one judgment call: everything else in this
phase is tests + report.)

## 3. What changed, precisely

### The finding: no dead end exists

`route()` returns answerless shapes on every decline (`EMPTY`/`NO_INTENT`/`AMBIGUOUS`/
`MISSING_SLOT_SLUG`), `answerDeterministic` translates every one of those into
`{ matched: false }`, and `answerQuestion` treats a non-match as "Tier 2's turn", not as a final
answer — the graph is then built and invoked unconditionally. `router.js`, `engine.js`, and the
turn flow were NOT modified in Phases 1–5 (only pre-read commits touch them), so there was no
regression to hunt: this is the verification pass the handoff describes.

### The one addition: `declinedReason` on the success payload

The fallthrough was real but SILENT: a model turn's `detail` had every field except the reason the
model was consulted, so an operator could not tell a direct LLM answer from a fast-path decline that
the catalogue should have caught. The LLM success path now carries
`detail.declinedReason = deterministic.reason`. The contract for consumers is additive-only: the two
surfaces that forward `detail` (the REST ask route, the socket `agent:complete`) pass it through
untouched, and two existing socket/REST test fixtures send `detail: {}` without breaking, which
proves unknown/missing keys are tolerated downstream.

### The two pins

- `agent-router.test.js` — *"a miss is a handoff"*: `route('مين الرئيس الحالي لمصر؟')` answers
  `{ matched: false, reason: 'NO_INTENT', candidates: [] }` with **no `answer`/`template` key**,
  so a future "helpful" default reply inside `route()` cannot quietly become the dead end

## 4. Verification (measured, not asserted)

| Run | Result |
|---|---|
| `tests/agent-router.test.js` + `tests/agent-service-db.test.js` + `tests/agent-engine-db.test.js` | **37/37 pass**, then **27/27** on the re-run after the `declinedReason` addition |
| full agent suite (`agent-*` + `ai-agent-*`, cap pinned, live server) | **266/266 pass, 0 fail** (~150 s) |
| `eslint .` repo-wide | clean (verified before commit, see below) |

266 vs the Phase 5 count of 264: +1 router-miss pin, +1 service fallthrough pin. (Phase 5's count was
taken before the `declinedReason` field existed; the fallthrough test initially failed on it and
forced the addition — the number documents both the pin and the fix.)

## 5. Anything unexpected

- **The new integration test failed first — on a REAL omission, not on wiring.** It expected the turn
  payload to record WHY the model ran, and nothing did: the decline reason lived only in a local and
  died with the turn. Rather than weaken the test, the phase took the one-field addition (`§3`) — a
  decision the report defends rather than hides, since Phase 6 was supposed to change nothing.
- **No second caller exists in the router itself.** Re-confirmed for the Phase 5 wrinkle: the outage
  path's fast-path consultation goes through `agentService.answerFactory` → the same
  `answerDeterministic` → the same `route()` — one function, two call sites in one turn, both pinned
  (the Phase 5 outage tests and this phase's fallthrough test).
- **Decline vocabulary is stable.** `route()`'s four decline reasons and the engine's six decline
  outcomes are unchanged and need no new vocabulary for the miss-to-model handoff: `NO_INTENT` is the
  recorded reason in both the router-unit and the service-integration pins.

## 6. Deviations from the phase prompt

One, and it is named above: the phase asked for zero source changes on a clean finding, and this round
made exactly one (a `detail` field). Everything else — no catalogue edit, no template edit, no route()
change — follows the verification-only instruction to the letter.

## 7. What the next phase must know

- **Phase 7 (memory tools) lands on a tier system whose routing is now fully pinned.** The three
  memory tools (`remember_fact`, `list_memories`, `forget_fact`) are action/read tools like any other:
  they must NOT be given fast-path intents (the deterministic tier is a cache for recurring platform
  questions, never a side channel for writes), and the Phase 2 prompt already tells the model when to
  save — no router change is wanted or needed.
- **`detail.declinedReason` is now reliable on every LLM turn.** Phase 7's "actually reflected in an
  answer" definition-of-done can read it to prove a memory-using answer came through Tier 2 (not a
  cached template): a memory test asserting `declinedReason !== null` on a memory-recall turn pins the
  right tier, not just the right text.
- **The 30-day conversation retention (used as the memory-window precedent) is untouched** and still the
  mechanism Phase 7's `pruneAgentMemories` must clone.
- Do not add a 29th intent that answers from memory: Decision #12 keeps the fast path a cache for
  platform questions, and a memory-reading deterministic answer would bypass the model the memory is
  meant for.

  Decision #12 forbids.
- `agent-service-db.test.js` — *"a question matching none of the 28 intents invokes the full
  graph"*: against the real database, a non-catalogued question builds the factory once, returns the
  scripted answer as the turn's answer with `source: 'llm'`, and records the decline that sent it
  there (`detail.declinedReason === 'NO_INTENT'`). The pre-existing mirror test (catalogued question
  never builds a graph) is untouched.
