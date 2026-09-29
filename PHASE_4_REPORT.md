# PHASE_4_REPORT.md

## 1. Goal

Soften the grounding guard from block-and-discard to warn-and-show (handoff §3.4, Decision #13).
Detection is unchanged — the same figures get flagged — but nothing is ever discarded, thrown, or
refused because of a number: every turn's worst case is an answer with a trailing one-line caveat.

| Requirement | Status |
|---|---|
| mismatch → flag + append, never discard/throw | Done, pinned in unit + service tests |
| raw question passed into the guard (new parameter) | Done (`options.question`) |
| tool-call arguments exempt (new parameter) | Done (`options.toolArgs`, collected in `agentService`) |
| tool-free turns skip the check entirely | Done (`skipped: 'NO_TOOLS'`, replaces the old no-evidence threshold) |
| figures attached to the turn's metadata | Done (`unverifiedFigures` on the persisted message, the answer `detail`, and the `AGENT_TURN` audit row) |

## 2. Files changed

```
 src/services/agent/answerGuard.js        |  advisory check: collectPermitted, skipped flag,
                                            withGroundingNote, UNVERIFIED_FIGURES_NOTE;
                                            AnswerGroundingError + assertGrounded +
                                            NO_EVIDENCE_MIN_DIGITS removed
 src/services/agent/agentService.js       |  grounding block replaced by the advisory path;
                                            collectToolCallArgs; groundedAnswer persisted +
                                            returned; unverifiedFigures on detail + audit
 src/services/agent/conversationService.js|  sanitizeTurnMetadata accepts capped
                                            unverifiedFigures
 tests/agent-answer-guard.test.js         |  4 tests inverted, 4 new, 3 renamed for truth
 tests/agent-service-db.test.js           |  refusal tests inverted to show-with-caveat
 PHASE_4_REPORT.md                        |  this file
```

## 3. What changed, precisely

- **`checkGrounded(answerText, payloads, options = {})`** keeps its reporting contract and gains the two
  §3.4 parameters (`options.question`, `options.toolArgs`). Numbers from either are merged into the
  permitted set for THIS turn only — nothing the admin once typed becomes a permanent fact. A turn with no
  payloads returns `{ ok: true, skipped: 'NO_TOOLS' }` instead of tightening the threshold.
- **`withGroundingNote(answerText, result)`** appends the handoff's exact one-liner to flagged answers only,
  idempotently; clean answers are returned byte-identical.
- **`agentService.answerQuestion`** now persists and returns the noted answer, carries
  `unverifiedFigures` in the `detail` and on the `AGENT_TURN` audit row, and no longer has any
  `GROUNDING_FAILED` path (the REST/socket surfaces already black-hole unknown codes, so their contracts
  are unchanged for them — details in §5).

## 4. Verification (measured, not asserted)

| Run | Result |
|---|---|
| `tests/agent-answer-guard.test.js` (pure) | **17/17 pass** |
| `tests/agent-service-db.test.js` (real database) | **10/10 pass** |
| full agent suite (`agent-*.test.js` + `ai-agent-*.test.js`, row cap pinned, live server) | **260/260 pass, 25 suites, 0 fail** (~150 s) |
| `eslint .` repo-wide | clean (exit 0 — verified below before commit) |
| Phase 4.5 live "إزيك؟" smoke (Phase 2 dependency) | still unrun — see §7 |

The 3.1 count was 258, this round 260: +4 new rule-pins (question exemption, tool-args exemption,
pure-conversation skip, caveat-exactly-once) minus the two old no-evidence tests that the skip rule
replaces. The agent-suite + service-db runs both hit the real staging Supabase; nothing in the diff
writes outside an `AgentMessage.metadata` JSON column the suite itself populates.

## 5. Anything unexpected

- **The refusal path is gone from the wire contract, and three doc-adjacent sites still describe it.**
  `GET /admin/agent/conversations/search`-era docs aside, `API-DOCUMENTATION.md` lists `GROUNDING_FAILED`
  as a documented 200-with-`ok:false` outcome (§557/630/682) and narrative (§771: "the answer itself arrives
  once, validated — or not at all"). It also says "no token is ever shown before it is validated"
  (`agentService.js:346` still says this). None of these was touched: the handoff's file scope stops at the
  agent module + its tests, and API docs + the sibling comment are owner-side edits. Flagged here instead —
  the row names, because they are the diffs to apply:
  - `API-DOCUMENTATION.md:557,630,682`: `GROUNDING_FAILED` no longer occurs; a flagged turn rides
    `ok:true` with `detail.unverifiedFigures` and the caveat line is part of `answer`.
  - `agentService.js:345-347`: "the grounding check still runs on the final answer before anyone sees
    it — no token is ever shown before it is validated" now means "flagged", not "blocked". It should say
    so (left for the owner; the line is accurate about ordering, wrong about consequence).
  - the FE's client (`lib/api-client.ts` compat shim + any `GROUNDING_FAILED` branch): a branch that can
    never fire is dead weight, and `detail.unverifiedFigures` is new data the console may want to render.
- **`findRefusedMutation` is untouched deliberately.** Its comment describes the pre-Phase-1 approval flow;
  it is inert (nothing matches it anymore) but that is Phase 6's verification territory (fast-path fallthrough),
  not something this phase's knife should reach for.
- **G1 landed as specified and stayed out of `node --check`**. `node --test` runs it 1:1.

## 6. Deviations from the phase prompt

None in behavior. Two documentation choices worth naming:

1. The `options.toolArgs` contract passes the whole args OBJECTS (via `collectToolCallArgs`, now exported
   from `agentService`) rather than numbers only — the guard's traversal is numeric-only anyway, and object
   fidelity keeps the seam honest about what the model sent. Flagged per Section 0 rule 4; sign-off welcome.
2. The caveat is appended to the PERSISTED answer too, not only the served one — "what the admin saw" and
   "what the transcript holds" must be the same text, or the transcript becomes unverifiable.
3. The three old `GROUNDING_FAILED` branch comments in the sibling `agent-service-db` orphan test were
   re-pinned to the advisory outcome rather than deleted — the sibling's Phase 4.5 lesson (every turn stores
   what it showed) is now the only orphan protection left.

## 7. What the next phase must know

- **R5 — needs sign-off (the grilling round's own flag, still open):** this guard was the only mechanical
  defence against a fluent fabricated statistic, and Decision #13 removed its teeth. What remains is a
  labelled caveat plus an auditable `unverifiedFigures` list. Two partial compensations survive: the Phase 2
  prompt ("any platform number must come from a tool"), and the flag is queryable per turn. A genuinely
  adversarial model is not stopped by any of this — say so in the Phase 5 brief, because the provider change
  (Gemini-only) is where the "what model are we trusting" question lands.
- **The tool-free skip is the widest hole in the new contract.** `checkGrounded(text, [])` now returns
  `{ ok: true, skipped: 'NO_TOOLS' }` by design (Decision #3): a small-talk greeting and an ungrounded count
  claim are indistinguishable to this check, and the handoff chose to never flag conversation. Any future
  "but count questions must still ground" rule would need a question-intent signal the guard does not have.
- **Phase 2's deferred smoke is now unblocked.** The Phase 2 report deferred the live "إزيك؟" turn to after
  the grounding change; with no discard path left, a greeting can no longer be eaten. The smoke still belongs
  in the Phase 5 round (provider wiring changes underneath it), not retroactively here.
- Do not re-add a block: downstream surfaces (REST black-hole, socket `agent:complete`) were left deliberately
  tolerant, and re-introducing a refusal code would fork the contract again.

- The metadata whitelist takes `unverifiedFigures` through the same sanitize doctrine as everything else
  (≤ 20 entries, ≤ 32 chars each), so the transcript answers "was this turn flagged?" with no answer
  content smuggled in.
- Dead by design: `AnswerGroundingError`, `assertGrounded`, and `NO_EVIDENCE_MIN_DIGITS` are gone — none had
  a live caller left (verified by repo-wide grep before removal).
