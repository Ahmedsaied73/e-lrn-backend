# PHASE_0_REPORT.md

## 1. Goal

Create the `agent-v2-rebuild` branch from `origin/Dev` and record a clean, reproducible baseline for the
existing agent test suite before any code change.

## 2. Files changed

| Path | Reason |
|---|---|
| `PHASE_0_REPORT.md` | new — this report |
| `UNDERSTANDING_REPORT.md` | new — the Stage-1 understanding report (delivered with the Stage-1 message, now committed so the branch history carries it) |

No source, test, config, schema or doc file was touched. `git diff --stat` against `c51e986` is empty for
every tracked file.

## 3. What I added / changed

- **Added** the two report files above.
- **Changed** nothing in code, tests, `package.json`, `prisma/`, or `.env`.
- **Did not commit** `.env` (gitignored) or any pre-existing untracked scratch file in the working tree
  (`.superpowers/`, `boot-*.txt`, `loadtest/`, `page.html`, `t3-dbg*.txt`, `t5-suite.txt`,
  `e2e-server.txt`, `scripts/seedLoadTestCohort.js`, `scripts/refreshLoadTestTokens.js`,
  `scripts/flushLoadTestBuckets.js`) — those were already there before Stage 1 and are not mine to add.

## 4. Branch

```
$ git rev-parse --abbrev-ref HEAD
agent-v2-rebuild
$ git rev-parse HEAD
c51e986c8289946fc25612c597c69c7bcc9a64d5
$ git rev-parse --abbrev-ref 'agent-v2-rebuild@{upstream}'
origin/Dev
```

The branch tracks `origin/Dev` and its tip is `c51e986` (Mon Sep 28 03:17:43 2026 +0300,
`fix(agent): Egyptian-dialect write intent + student_search boost for phone lookups`) — the Dev tip, not
`staging`. Nothing has been pushed.

## 5. How a single test file is run (confirmed, per Phase 0)

`npm test` (`node scripts/run-tests.js`) has **no file filter** — it always runs `tests/**/*.test.js`. The
single-file path is the repo's `test:direct` shape: start the app yourself, then point `node --test` at
files. The exact commands I use from here on:

```powershell
# 1. server (once per session), same port/shape the repo runner uses
$env:PORT='3106'; $env:NODE_ENV='development'
Start-Process node -ArgumentList 'app.js' -PassThru -NoNewWindow `
  -RedirectStandardOutput "$env:TEMP\p0-out.txt" -RedirectStandardError "$env:TEMP\p0-err.txt"
# wait for http://127.0.0.1:3106/health -> {"status":"ok","db":"up"}

# 2a. ONE file
$env:TEST_BASE_URL='http://127.0.0.1:3106'; $env:AI_AGENT_MAX_TOOL_RESULT_ROWS='50'
node --test tests/agent-pii.test.js

# 2b. the whole agent suite (the baseline shape)
node --test --test-concurrency=1 tests/agent-*.test.js tests/ai-agent-*.test.js
```

**Why the row-cap pin is part of the command:** the developer `.env` sets
`AI_AGENT_MAX_TOOL_RESULT_ROWS=100`, while three tests assert the *shipped default* of 50. Pinning the
variable to its default (it is a process env var, so it wins over `.env`, which never overrides an
existing value) makes every run comparable to the baseline and removes the three environmental failures.
This is an environment pin, never a code change.

Single-file command proof:

```
$ node --test tests/agent-pii.test.js
ℹ tests 9   ℹ pass 9   ℹ fail 0   ℹ duration_ms 132.7647
```

## 6. Baseline (clean)

```
$ node --test --test-concurrency=1 tests/agent-*.test.js tests/ai-agent-*.test.js   # cap pinned to 50
ℹ tests 259
ℹ suites 26
ℹ pass 259
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 154875.0828
```

Independent checks on the same output file: `failing tests` sections = **0**, lines matching
`AssertionError|Error:|✖` = **0**. Every one of the 26 suites printed a leading `✔`.

The 22 files in the run (20 `tests/agent-*.test.js` + 2 `tests/ai-agent-*.test.js`):

```
agent-actions-crud, agent-actions-intent, agent-answer-guard, agent-approvals-db,
agent-conversation-db, agent-engine-db, agent-graph, agent-history-compaction,
agent-limits, agent-llm-provider, agent-pii, agent-rest, agent-router, agent-schema-tools,
agent-service-db, agent-socket, agent-templates, agent-tool-payload-cap, agent-tools-contract,
agent-tools-db   +   ai-agent-config, ai-agent-deps
```

(Node's spec reporter labels *suites*, not files, in a piped run — so a per-file tally is not printed.
With 0 failures across 259 assertions, no file is failing. If a per-file tally is ever wanted,
`--test-reporter=tap` labels each file; I will use it if a phase needs to attribute a failure to a file.)

### Baseline vs. the Stage-1 run (why the pin matters)

| Run | Row cap | tests | pass | fail |
|---|---|---|---|---|
| Stage 1 (`.env` value) | 100 | 259 | 256 | 3 (all `meta.cappedAt === 50`) |
| **Phase 0 (pinned to the shipped default)** | **50** | **259** | **259** | **0** |

**This 259/259 is the line no later phase may cross.** Any future red is then attributable to that phase's
own change, which is exactly why the pin is recorded here.

## 7. Definition of done

| Criterion (from the handoff's Phase 0) | Status | Proof |
|---|---|---|
| Branch `agent-v2-rebuild` created from `origin/Dev`, not `staging` | **MET** | §4: upstream is `origin/Dev`, tip `c51e986` |
| The full existing agent suite run once, unmodified, and recorded | **MET** | §6: 22 files, 259 tests, 259 pass, 0 fail, command and raw counts pasted |
| A clean baseline for later phases to be measured against | **MET** | §6 comparison table; the three environmental failures are gone under the pinned cap, and the pin is documented in the run command |
| The exact invocation for a single test file confirmed | **MET** | §5, with output from `tests/agent-pii.test.js` |

## 8. Assumptions needing sign-off

**None.** Phase 0 changes no behaviour. (The row-cap pin is documented in §5 as an environment choice, not
a code or test change; if you would rather I run every phase with the local `.env` value of 100 and accept
three known-red assertions, say so and I will switch conventions.)

## 9. Noticed, not touched

- The working tree carries pre-existing untracked scratch output (`.superpowers/`, `boot-off.txt`,
  `boot-on3.txt`, `e2e-server.txt`, `page.html`, `t3-dbg.txt`, `t3-dbg2.txt`, `t5-suite.txt`, `loadtest/`,
  three `scripts/*LoadTest*.js` helpers). Left alone; I will not commit them unless you ask.
- `.env` sets `AI_AGENT_MAX_TOOL_CALLS=20`, which `env.js:273` silently clamps to 10. Behaviour is correct;
  the env value is just misleading. Not touched (it is your runtime config).
- `scripts/smoke-agent.js` (`npm run smoke:agent`, `RUN_LIVE_AGENT=1`) exists and looks like the right
  vehicle for the Phase 10 manual script; not touched yet.

## 10. Next phase risks (Phase 1)

- Phase 1 removes the code that the Dev-tip commit `c51e986` was entirely about (the Egyptian-dialect
  `WRITE_VERBS` and the `student_search` phone boost live inside `selectToolSet`/`hasWriteIntent`). Their
  purpose disappears by decision — nothing replaces them, because all read tools are always bound.
- Four suites carry assertions that Phase 1 necessarily invalidates (`agent-actions-intent` wholesale;
  `agent-graph` "SHORT tool surface" :199-216; `agent-schema-tools` :223-231; `agent-tools-contract`
  :421-429,519-533). Each deletion will be named individually in that report, with the reason it was
  removed, per the Stage-2 rule.
- Measured cost to watch in that phase: binding all 53 tools makes the model-facing schema ~9,470 tokens
  per model call (reads-only ~5,291), re-sent on every step of the loop. Phase 1's definition of done
  asserts the *surface*, and your Q3 answer adds the per-turn measurement to the turn audit metadata —
  that measurement is the sensor for this risk.
