# Implementation Plan: run-to-zero (remaining audit tail)

## Overview
After Q-5, the confirmed remaining work is ordered below by dependency and
risk. Each item is independently verifiable and net-zero where fixtures are
needed. Parked items (need user answers or out-of-scope approvals) are listed
separately and NEVER started without explicit order.

## Order rationale
Deployability first (Docker/env blocks all future prod verification), then
small isolated correctness (AI-4, log hygiene), then supply chain (prune +
targeted upgrades), then schema/concurrency work (D-5), then FE behavior
(F-1, F-4), then process (test runner). Risky/ambiguous items sit last or
parked.

## Task list (also in `tasks/todo.md`)
- [ ] R1 — Docker/env repair
- [ ] R2 — AI-4 budget counts retries (+ fail-open doc line)
- [ ] R3 — dep prune (axios, nodemailer, bare langchain) + audit triage
- [ ] R4 — D-5 assignment indexes (migration)
- [ ] R5 — notify trigger catch{} warn logs
- [ ] R6 — F-1 autosave queues behind in-flight save
- [ ] R7 — F-4 dead weight: import-graph proof, then delete-or-mount
- [ ] R8 — test runner seed (node:test BE quiz-lifecycle + vitest FE result-gating)
- [ ] Checkpoint Z — trees clean, servers live, matrix green

## Parked (need user — see Open questions)
- P-A S-8 trust proxy (blocked on L-1 topology answer)
- P-B V-1 Bunny Token-Authentication dashboard check (user clicks)
- P-C Q-5 essay/AI live proof (blocked on GEMINI_API_KEY provisioning)
- P-D F-4 toast bridge: mount vs delete is a product call (queued in R7 grill)

## Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Dep upgrade breaks runtime (qs/express chain) | High | One dep per commit, changelog read, full matrix re-run; prune (deletion) before upgrades |
| D-5 migration locks tables | Low | `CREATE INDEX CONCURRENTLY` aware; off-peak; small tables today |
| F-1 changes save timing | Med | Keep 25s debounce + flush triggers; queue only the dropped write |
| R7 deletes something actually used | Med | Import-graph proof committed as evidence BEFORE any deletion |

## Open questions (grill — user must answer)
1. L-1: prod behind proxy/LB? (unlocks P-A)
2. V-1: is Bunny Token-Authentication ON? (P-B, one dashboard look)
3. Confirm deletions: axios, nodemailer (+EMAIL_* env), bare langchain? (R3)
4. Toast bridge: mount it or delete it? (decides R7 outcome)
5. Test runner adoption: node:test + vitest, starting with 7 flows? (R8)
6. Batch order: R1→R8 as listed, or re-prioritize?
