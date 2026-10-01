# PHASE_2_REPORT.md

## 1. Goal

Replace the static `SYSTEM_PROMPT` constant in `src/services/agent/graph.js` with a per-turn
`buildSystemPrompt()` (handoff §3.2): the Egyptian-colloquial conversational persona, the live
Cairo date line, no hard-coded tool list, and a memory seam that stays invisible until Phase 7.

## 2. Files changed

```
 src/services/agent/graph.js | 83 ++++++++++++++++++++++++++++++--------
 tests/agent-graph.test.js   | 78 ++++++++++++++++++++++++++++++++++++-
```

| Path | Reason |
|---|---|
| `src/services/agent/graph.js` | `SYSTEM_PROMPT` const deleted; added `MEMORY_BLOCK_LABEL`, `formatCairoDate(now)`, `buildSystemPrompt({ now, memories })`; `agentNode` now sends `new SystemMessage(buildSystemPrompt())`; exports swapped (`SYSTEM_PROMPT` out — `buildSystemPrompt`, `formatCairoDate`, `MEMORY_BLOCK_LABEL` in) |
| `tests/agent-graph.test.js` | scripted-model capture gains `firstMessage` (one added field); four Phase 2 tests appended (persona in / old rules out; live Cairo date; additive memory seam; agentNode sends a freshly built prompt) |

`git grep SYSTEM_PROMPT` across `src`, `tests`, `scripts`: **zero** code references remain (only
prose in `AGENTS.md`, `PHASE_1_REPORT.md`, `UNDERSTANDING_REPORT.md`, and the unrelated
`src/services/aiGrader/prompts.js`, which owns its own constant).

## 3. What changed, precisely

- **The prompt text** is a literal transcription of handoff §3.2 — twelve paragraphs joined by
  blank lines, one paragraph per array entry so diffs and reviews stay line-scoped. The old
  13-rule block (MSA mandate, rule-7 capability dump, "أنتظر موافقته" pending-approval prose,
  one-action-per-request) is gone, and the new tests assert its ABSENCE.
- **The date line** — `النهارده <ar-EG weekday, d month yyyy> بتوقيت القاهرة.` — is injected as
  the second paragraph from `new Date()` at call time. `formatCairoDate` uses
  `Intl.DateTimeFormat('ar-EG-u-ca-gregory', { timeZone: 'Africa/Cairo' })`; the clock is
  injectable so tests are deterministic. A test pins the TIMEZONE conversion, not just
  interpolation (23:00Z on the 28th renders as the 29th in Cairo).
- **The memory seam** — `buildSystemPrompt({ memories })` accepts plain strings or `{ content }`
  rows, drops blanks, and appends them under `MEMORY_BLOCK_LABEL` as a clearly separated final
  block (handoff §3.9's label). An empty/absent list changes ZERO bytes of the prompt, so Phase 7
  can wire real memories without any prompt-shape change elsewhere.
- **Nothing else moved**: `agentNode`'s message assembly is still
  `[SystemMessage, ...compactToolPayloads(state.messages)]`; tool surface, budget, approval
  machinery, and compaction were not touched.

## 4. Verification (measured, cap pinned to the shipped default)

Known environment noise first: the local `.env` carries `AI_AGENT_MAX_TOOL_RESULT_ROWS=100`, which
fails three `meta.cappedAt === 50` pins; Phase 0 documented this and pins the env var for test
runs. All runs below use `AI_AGENT_MAX_TOOL_RESULT_ROWS=50`.

| Run | Result |
|---|---|
| `node --check` + lint on both files | clean (tests dir is ESLint-ignored by existing config) |
| `node --test tests/agent-graph.test.js` | **12/12** (8 prior + 4 new Phase 2) |
| graph + contract + payload-cap + compaction + answer-guard + templates | **83/83** |
| engine-db + conversation-db + approvals-db + actions-crud + schema-tools | **57/57** |
| ai-agent-config + ai-agent-deps + llm-provider | **30/30** |
| built prompt size | 2,234 chars (~560 tokens at chars/4) — the tool surface still dominates the turn |

**Phase-2 definition of done**: the handoff defers the live "إزيك؟" smoke to after Phase 4
(grounding guard). The unit stand-in is in place and green: a scripted-model turn with «إزيك؟»
runs the graph with zero tool calls and the model receives the freshly built prompt with today's
Cairo date. The live staging smoke remains open, per the handoff's own dependency note.

## 5. Assumptions made — need sign-off

1. **Date-line wording**: §3.2 says "inject the current date" without giving the sentence. I chose
   `النهارده <ar-EG date> بتوقيت القاهرة.` as its own second paragraph (Egyptian register, matches
   the rest). Trivial to reword — one template line.
2. **Tanween normalisation**: the handoff document itself carries double-tanween encoding
   artifacts (`دائماًا` = tanween + tanween-on-alif). The transcription uses the standard single
   mark (`دائماً`, `أياً`, `فورااً`, `أولااً`). Words are otherwise byte-identical.
3. **Memory-block rendering** (label suffix `(من محادثات سابقة)`, `- ` bullets) is my choice
   within §3.9's "clearly-labeled block" wording; Phase 7 may re-tune it. Until then NOTHING
   calls the `memories` parameter — `agentNode` builds the prompt with defaults only.
4. **Transient prompt/tool gap**: §3.2's prompt already tells the model it can save memories
   «بأداة الحفظ», but `remember_fact` only arrives in Phase 7. Asked to remember something today,
   the model reports the failure honestly (the prompt's last paragraph) rather than inventing a
   tool. This is the handoff's own ordering (prompt in Phase 2, tool in Phase 7); flagged per
   rule 4, not fixed by deviating from the phase order.
5. **Export surface**: `SYSTEM_PROMPT` left `module.exports`; nothing in `src`/`tests`/`scripts`
   consumed it (grep-verified), so the swap breaks no importer.

## 6. Next phase risks (Phase 3)

- Removing the `ctx.approved !== true` gate from `KIND_ACTION` in `_kit.js` will invert assertions
  in `agent-tools-contract.test.js` ("refuses an action with no approval") and several
  `agent-actions-crud` cases — expected per the handoff; update those specifically, not the files.
- The new prompt already promises preview-then-confirm for deletes/broadcasts; until Phase 3 ships
  `confirmableActionTool`, that promise is prompt-level only. The `_kit` approval gate still
  refuses every action in the meantime — safe, but it contradicts the prompt's "the system
  executes right away" line. **Do not smoke-test writes against staging before Phase 3.**
- `graph.js`'s file-header comment (lines 17–19) still describes the pre-Phase-1 "12 mutating
  tools" surface; Phase 3 touches this file anyway and can refresh it.
- Working tree at phase end: `graph.js` + `agent-graph.test.js` modified, `PHASE_2_REPORT.md` new
  (plus the owner's own uncommitted `PHASE_1_REPORT.md` corrections, untouched by this phase).
  Nothing committed or pushed — per rule 5, the owner applies and pushes.