# Rollout Plan — Visual Math & Chemistry Editor

This document outlines the step-by-step deployment and rollout procedure for Ahmed.

---

## 1. Overview & Invariants

- **Zero Database Migrations**: All rich questions, answer formats, and student responses utilize existing PostgreSQL `JSONB` columns (`Quiz.surveyJson`, `QuizAttempt.responses`, `answerKey`). No `prisma migrate deploy` is required for this feature.
- **Zero CDN Dependencies**: All 20 MathLive `.woff2` font files are self-hosted in `public/mathlive/fonts/`.
- **Zero Bundle Bloat**: KaTeX and MathLive are dynamically loaded on rich quiz routes only. Shared First Load JS remains 80.7 kB.
- **Fail-Safe Rollback**: Setting `NEXT_PUBLIC_RICH_INPUT_ENABLED=false` immediately falls back to the baseline plain textarea while existing rich envelopes continue rendering safely in read-only mode via `<RichView>`.

---

## 2. Environment Variables Matrix

| Variable | Staging | Production (Initial) | Production (Active) | Description |
|---|:---:|:---:|:---:|---|
| `NEXT_PUBLIC_RICH_INPUT_ENABLED` | `true` | `false` | `true` | Master toggle for rich essay input |
| `NEXT_PUBLIC_HANDWRITING_ENABLED` | `false` | `false` | `false` | Strictly disabled (Phase 8 shell only) |
| `HANDWRITING_ENABLED` (Backend) | `false` | `false` | `false` | Strictly disabled (zero external API calls) |
| `AI_STUDENT_SUBJECT` / `NEXT_PUBLIC_SUBJECT_NAME` | `MATH` | Deployment Subject | Deployment Subject | Subject profile resolution |

---

## 3. Phased Rollout Procedure

### Phase 1: Deploy to Staging
1. **Backend Deployment**:
   - Merge `Dev` into `staging`.
   - Ensure `HANDWRITING_ENABLED=false` is set in Railway staging variables.
   - Verify health: `GET https://e-lrn-backend-staging.up.railway.app/health` returns `{"status":"ok","db":"up"}`.
2. **Frontend Deployment**:
   - Deploy `Dev` branch to staging on Vercel/Netlify.
   - Configure staging env:
     ```bash
     NEXT_PUBLIC_RICH_INPUT_ENABLED=true
     NEXT_PUBLIC_HANDWRITING_ENABLED=false
     ```
   - Verify static build compiles 29/29 routes cleanly.

### Phase 2: Smoke Testing on Real Devices
Perform the Section 4 checklist across iOS Safari, Android Chrome, and Desktop Chrome:
1. **Student Taking**:
   - Open a rich math/chemistry essay question.
   - Insert equations using virtual science keyboard and physical keyboard.
   - Verify Arabic math rendering (e.g. `س^2 + ص^2 = 25`).
   - Refresh page to verify autosave block recovery.
   - Submit attempt.
2. **Results & AI Grader**:
   - Verify KaTeX formatting in student results screen.
   - Check AI grading criteria breakdown.
3. **Teacher Inbox**:
   - Open `/admin/grading` and verify teacher preview renders equations with `<RichView>`.
4. **Plain Subject Isolation**:
   - Open an Arabic or English quiz to confirm 100% byte-for-byte identical legacy plain textarea behavior.

### Phase 3: Production Rollout (Canary to 100%)
1. **Deploy with Flag OFF**:
   - Merge `Dev` to `master` / `main`.
   - Set `NEXT_PUBLIC_RICH_INPUT_ENABLED=false` on production.
   - Deploy backend and frontend. Confirm production operates with zero change to current behavior.
2. **Teacher Canary**:
   - Enable `NEXT_PUBLIC_RICH_INPUT_ENABLED=true` for internal admin/teacher testing.
   - Author a rich exam using the preview toggle in `<RichField>`.
3. **General Availability (GA)**:
   - Enable for all students.
   - Monitor Sentry and server `/metrics` for any submission errors.

---

## 4. Emergency Rollback Protocol (< 30 Seconds)

If any unexpected client crash or browser incompatibility occurs:
1. In Vercel / Netlify dashboard, set:
   ```bash
   NEXT_PUBLIC_RICH_INPUT_ENABLED=false
   ```
2. Redeploy frontend (or promote instant rollback release).
3. **Behavior during rollback**:
   - Student essay questions immediately revert to standard plain `<textarea>`.
   - Stored rich envelope answers already submitted continue to render seamlessly via `<RichView>`.
   - Zero database cleanup or backend reverts required.
