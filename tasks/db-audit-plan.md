# DB Production-Readiness Audit — Stage 1 Plan (READ-ONLY)

## Overview
Read-only production-readiness audit of the Supabase Postgres behind this Express+Prisma app. Stage 1 only: discover → measure → audit → analyze → design → plan. No DDL, no mutations, no business-logic changes. EXPLAIN only (no EXPLAIN ANALYZE). Stop for human review after the report.

Approved 2026-09-14. Task files: `tasks/db-audit-plan.md` (this), `tasks/db-audit-todo.md`. Existing `tasks/plan.md` / `tasks/todo.md` (run-to-zero) untouched.

## Assumptions
1. Target = currently-connected Supabase project (`DATABASE_URL` pooled 6543 / `DIRECT_URL` 5432).
2. Current dataset is tiny (User 12, Course 1, BunnyVideo 3, Quiz 3, QuizAttempt 24) — scale reasoning is projective, labeled by confidence.
3. Prisma is the only DB access path for app code (no PostgREST dependency); RLS on with zero policies is therefore fail-closed for anon/authenticated via API, fail-open only if Data API is exposed.
4. `EXPLAIN` (no ANALYZE) is safe on prod.

## Architecture decisions
- Evidence hierarchy: source code (file:line) + DB metadata (`pg_indexes`, `pg_stat_*`, advisors) + `EXPLAIN` plans. Anything else labeled VERIFIED / LIKELY / POSSIBLE / REQUIRES RUNTIME MEASUREMENT.
- No index/cache/tx recommendation without a tied query + cost + invalidation/rollback note.
- Findings graded CRITICAL / HIGH / MEDIUM / LOW / INFO.

## Task list (see db-audit-todo.md; phases A–F)
- A: App→DB inventory (all Prisma ops, N+1, pagination flags)
- B: Schema + index baseline vs migrations
- C: Query perf, EXPLAIN only + pagination audit
- D: Connections / transactions / cache / health
- E: Security / privacy / abuse
- F: Scale model, advisors, baseline, P0–P3 recs, load-test + verification + rollback plans → STOP

## Dependency graph
```
schema.prisma + migrations → config/db, env, redis → services/controllers/middlewares/jobs → routes (app.js) → Supabase runtime (stats, RLS, pooler)
```

## Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| pg_stat_statements missing/reset | Med | Code-frequency fallback; mark REQUIRES MEASUREMENT |
| Tiny data hides bad plans | High | 10x/100x projection; no capacity claims without load test |
| Accidental mutation | High | SELECT/EXPLAIN only; no apply_migration; double-check every query verb |

## Open questions (for Stage-2 gate, not Stage 1)
- Data API exposure settings for `public` schema?
- Prod topology (single Node vs multi-instance; pooler mode)?
- Approval for future EXPLAIN ANALYZE + load tests?
