# PHASE_7_REPORT.md

## 1. Goal

Cross-conversation memory (handoff §3.9, Decisions #21–22): the agent learns a durable fact in one
conversation and still knows it in the next one. Scoped to a per-admin `AgentMemory` table, three
tools, a per-turn prompt block, and a daily retention sweep.

| Requirement | Status |
|---|---|
| a fact learned in conversation A reaches the prompt of conversation B | Done, pinned in tests AND against the real database |
| a fact can be retracted | Done (`forget_fact`) — the one deliberate scope addition |
| reading memory never costs an answer | Done: a failing loader degrades to "no memories this turn" |
| memory expires | Done: 30-day window, daily 03:47 sweep, own Redis lock |
| one admin can never see, write, or delete another's memory | Done: every query scoped by `ctx.adminId` |

## 2. Files changed

```
prisma/schema.prisma                    | +27  model AgentMemory (+ its two relations + index)
prisma/migrations/20261001000000_.../    | +47  applied to the live DB (status: up to date)
src/services/agent/memoryService.js     | new  per-turn loader + retention sweep
src/services/agent/tools/memory.js      | new  remember_fact / forget_fact / list_memories
src/services/agent/tools/index.js       |  +7  registry: reads always visible, actions gated like the rest
src/services/agent/graph.js             | +45  MEMORY_BLOCK_LABEL, buildSystemPrompt(memories), loadTurnMemories seam
src/services/agent/agentService.js      | +13  the loader closure, bound to the calling admin
src/jobs/pruneAgentMemories.js          | new  daily 03:47 sweep (twin of pruneAgentConversations)
app.js                                   | +22  start beside the conversation sweeper, own stop on shutdown
src/config/env.js                        |  +6  AI_AGENT_MEMORY_RETENTION_DAYS (default 30, clamp 1..3650)
.env.example                             |  +9  documented, including what reading does NOT do
tests/agent-memory.test.js               | new  564 lines / 28 tests — pure logic against a stub

### Injection never writes

`loadTurnMemories` is a seam on `createAgentGraph`, and `agentService` binds it to a closure that
already knows the calling `adminId` — so the scoping cannot be forgotten at a call site. The block
is appended to the system prompt as a labelled section, separate from live history, under
`معلومات محفوظة عن المشرف والمنصة (من محادثات سابقة)`. **Reading a fact does not move its
`updatedAt`**: a bump-on-read window would never expire for an admin who simply keeps chatting, and
would spend one write per model call. Editing or creating a fact does move it to the front.

Memory is never allowed to cost an answer. The loader is awaited inside a `try/catch` that degrades
to `[]` and logs `agent.memory_load_failed`; a turn with **no** loader wired is byte-identical to
the pre-Phase-7 agent, which is the pin that makes the seam safe to leave unconnected.

### Retention

`pruneAgentMemories.js` is cloned from `pruneAgentConversations.js` on purpose — same cron shape,
same distributed lock, same fail-open policy, same select-then-delete (Postgres has no
`DELETE ... LIMIT`). It runs at **03:47**, not 03:17 and not on the hour, so the three daily ticks
never stack. Lock key `lock:prune-agent-memories`, distinct from the conversation lock; a test pins
that they are different keys. A Redis failure at lock time falls back to the process-local guard
rather than disabling retention — the worst case of a doubled sweep is deleting a batch twice.

A `remaining > 0` after a run is logged as a **backlog**, not an error: the 200-row cap means a
large backlog drains over successive days.

## 4. Judgment calls

1. **`forget_fact` was added although §3.9 did not list it.** A memory system that cannot retract a
   wrong row is a liability the moment it stores something wrong — and these rows are the model's
   own phrasing about the admin, so a confidently-stored falsehood is the expected failure mode.
   A missing id returns `MEMORY_NOT_FOUND` rather than silently no-op'ing, so the model learns the
   correction did not happen.
2. **No `updatedAt` bump on read** (above) — the retention window would otherwise be unenforceable
   for the most active admins, who are the ones with the most rows.
3. **Memory rows carry the injection doctrine unchanged.** A stored fact is admin-authored-by-proxy
   text; the existing rule that tool output is DATA, never instructions, covers it. A test pins
   that a fact which round-tripped through student-authored text is still only text in the block.
4. **`MEMORY_TURN_LIMIT = 50`.** §3.9's own starting number. The block is a list of short lines, and
   the crowding case is the right thing to revisit once real data exists.
5. **Removed a duplicate never-throw wrapper** in the graph's memory path — the seam already owns
   that policy, and two catches would have hidden which one was load-bearing.

## 5. Verification

| Check | Result |
|---|---|
| `node --test tests/agent-memory.test.js` | **28/28 pass** |
| `node --test tests/agent-memory-db.test.js` | **5/5 pass** (real table, real prompt) |
| 7 agent suites incl. the two new ones | **111/111 pass** |
| `npx eslint .` | clean |
| `npx prisma migrate status` | up to date (21 migrations) |
| `prisma validate` | valid |

The DB suite is the one that matters most, because a stub cannot answer the two questions it exists
for: does the table really have the columns the code names, and does a fact survive the whole chain
— table → the per-turn loader closure → the system prompt a Tier-2 turn is actually shown. Both are
pinned, using `detail.declinedReason` (Phase 6) to prove the turn reached the model rather than a
cached template. Net-zero: every row it creates it deletes in `cleanup`.

## 6. Operational notes

- `AI_AGENT_MEMORY_RETENTION_DAYS` is added to `.env.example` and to the local `.env` (30). The
  variable is optional — the default is 30 — so an environment that never sets it behaves exactly
  like this one.
- The migration is **applied** to the database this repo points at, and `prisma migrate status`
  reports up to date. Deploying the branch needs no manual step.
- The new tables read nothing from the model-facing surface except through the three tools, so the
  feature is inert while `AI_AGENT_ENABLED=false` (the job is gated on the same flag, exactly like
  the conversation sweeper).

tests/agent-memory-db.test.js            | new  171 lines / 5 tests — the real table, the real prompt
```

## 3. What changed, precisely

### The table

`AgentMemory` is one freeform fact in the agent's own words: `adminId` (required FK, cascades with
the user), `content` (Text, 3–500 chars enforced in the tool schema), `sourceConversationId`
(nullable, `SetNull` — deleting a conversation must not delete a fact, it just loses provenance),
and `createdAt`/`updatedAt`. Indexed `@@index([adminId, updatedAt(sort: Desc)])`, which is exactly
the per-turn query: one admin's rows, newest-touch first.

### The three tools

`remember_fact` and `forget_fact` are **actions** (audited, gated behind
`AI_AGENT_ALLOW_MUTATIONS`); `list_memories` is a **read** (always bound). Attribution comes from
`ctx.adminId` inside `_kit.execute()` and never from a tool argument — a model cannot store a
memory for, read the memories of, or delete the memory of another admin, and the tests pin each of
those three refusals. `list_memories` sets `cacheTtlSeconds: 0` deliberately: memory changes
mid-conversation, and a cached list would let the agent tell the admin a fact still exists after
forgetting it in the same turn.
