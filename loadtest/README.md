# k6 Load-Test Harness — 10k Concurrent Online Users

## Model

`U/10` arrival rate: a student acts every 5–15s (mean ~10s), so `rate = U/10` iterations/sec models `U` **online** users. 10k online ≈ **1000 iterations/s** at peak, not 10k open sockets.

## Prerequisites

1. **Seed the cohort once**: `node scripts/seedLoadTestCohort.js` → produces `loadtest/.tokens.json` (JWTs + fixture slugs). Never commit it.
2. **Boot the server with the LOAD_TEST profile** (raised rate-limit ceilings):
   - `LOAD_TEST=true`
   - `DATABASE_CONNECTION_LIMIT=40` (Supabase pooler headroom)
   - **Redirect stdout to a file**: `npm run dev > server-lt.log 2>&1` — the JSON request logger will crush a console at 1k req/s.
3. k6 v2.x on PATH.

## Stages

| Stage | Command | Online users |
|---|---|---|
| L0 smoke (60s, 1 VU sanity) | `k6 run -e STAGE_CAP=1 loadtest/scenarios/browse-10k.js` | ~10 |
| L1 baseline | `k6 run -e STAGE_CAP=10 loadtest/scenarios/browse-10k.js` | 100 |
| L2a | `k6 run -e STAGE_CAP=50 loadtest/scenarios/browse-10k.js` | 500 |
| L2b | `k6 run -e STAGE_CAP=120 loadtest/scenarios/browse-10k.js` | 1,200 |
| L3/L4 full ramp | `k6 run loadtest/scenarios/browse-10k.js` | → 10,000 |
| Login surge (evening herd) | `k6 run loadtest/scenarios/login-surge.js` | 1,000 logins / 5 min |
| Spike (5x in 60s) | `k6 run loadtest/scenarios/spike.js` | 1k→5k surge |
| Soak | `k6 run loadtest/scenarios/soak.js` (env: `SOAK_RATE`, `SOAK_DURATION`) | 6,000 sustained 45m |

`-e BASE_URL=...` overrides the target (default `http://localhost:3005`).

## Between-stages protocol

```
node loadtest/lib/snapshot.js L1        # snapshot /metrics + /readyz (never fails)
node scripts/flushLoadTestBuckets.js    # clear stale rl:* → no phantom 429s
```
Then **inspect** the k6 summary (thresholds: p95, req_failed, checks) → continue or halt. Summaries land in `loadtest/results/<scenario>-summary.json`, snapshots append to `loadtest/results/metrics-<label>.txt`.

## Halt criteria

- **p95 doubles the stage gate** (e.g. L1 gate ~250ms → observe ~500ms) — latency cliff, don't push further.
- **5xx > 1%** of requests — capacity or a bug; stop and triage the server log.
- Any threshold failure makes k6 exit non-zero — treat that as a halt signal.

## CEILING — read this before quoting numbers

These runs measure the **single-instance ceiling**: one Node.js process on a 4-core box, with app↔DB round-trips over home internet to staging Supabase. Expect every DB-touching endpoint to carry that RTT inflation vs a co-located production DB — the p95 here is an *upper bound* on real-world latency for the same code, not a production prediction. Production capacity scales horizontally behind a load balancer (per-instance rate limits then need shared Redis); L4 validates that one instance is survivable and where it folds, nothing more.
