# Quiz Bugs — Fix Plan (Sept 2026)

User-reported bugs, confirmed root causes, and the execution plan.
Companion FE coordination notes go in `../<frontend>/plans/frontend-handoff.md` after execution.

## Decisions (grilled with user, all confirmed)

- **Bug 5 (leave = auto-submit)**: HYBRID — client submit-on-leave (`beforeunload`/`pagehide` + Next route unmount, fetch `keepalive`) AND server-side stale finalization (any IN_PROGRESS attempt older than 30 min on an **untimed** quiz is auto-submitted with its saved responses on the next start, then a fresh attempt is created). Accidental back/refresh within 30 min still resumes → no lost work, no burned attempt. Intro "محاولة قيد التنفيذ" banner removed.
- **Bug 2 (achievements link)**: new `/me/user/achievements` page; navbar `إنجازاتي` → `/grades/2` REPOINTED to it; dead links retired (`بنك الأسئلة` → `/me/user/exam-results`, profile `نتائج الامتحانات` → `/me/user/all-exam-results` → repointed to achievements).
- **Bug 4 (pass = locked)**: server `startAttempt` returns 409 `ALREADY_PASSED` once `best GRADED scorePercent >= passingScore`. UI shows success state (never "استنفذت المحاولات"). `bestScore` stays the stored grade (no new column).
- **Bug 1 (untimed tile)**: time tile shows `بدون` instead of `--`; `totalQuestions`/`totalPoints` now come from backend meta.

## Confirmed root causes

| Bug | Root cause |
|-----|-----------|
| 1 | `getQuizMeta` never includes `totalQuestions`/`totalPoints` (types/quiz.ts notes "not yet in backend"). `100/--` = `bestScore / meta.totalPoints ?? "--"` in `QuizIntroCard`. |
| 2 | No real exam-results/achievements page; `/me/user/exam-results` + `/me/user/all-exam-results` are dead routes; navbar `إنجازاتي` wrongly → `/grades/2` CourseCatalog. |
| 3 | `/courses/enrolled` returns `[{ id: enrollmentId, createdAt, course }]` but `subscriptions/courses` pages type it as flat `CourseListItem[]` → blank/broken cards + wrong hrefs. |
| 4 | `startAttempt` has no "already passed" check → retries after passing. |
| 5 | `QuizRunner` never submits on leave; intro card in-progress banner uses `useQuizTimer` → stray `--` for untimed. |
| 6 | `QuizIntroCard` CTA checks `outOfAttempts` before `hasPassed` → exhausted message even when last attempt passed. |

## Backend changes (`H:\e-learning-platform`)

1. `src/config/quizConfig.js` — add `STALE_ATTEMPT_MS = 30 * 60 * 1000`.
2. `src/services/quizService.js`
   - `countQuestions(surveyJson)` helper (scorable elements: radiogroup/comment).
   - `startAttempt(userId, quizId, { bypassPassedCheck = false })`:
     - **Passed block**: `bestGraded.scorePercent >= quiz.passingScore` → `throw { statusCode: 409, code: 'ALREADY_PASSED' }` (skip when `bypassPassedCheck`, i.e. admin).
     - **Stale finalize**: existing timed lazy-expiry stays. For `deadlineAt === null` and `now - startedAt >= STALE_ATTEMPT_MS` → `finalizeStaleAttempt(inProgress, quiz)` then create a new attempt. Fresh in-progress still resumes.
   - `finalizeStaleAttempt(attempt, quiz)` — auto-grades `attempt.responses` via `gradeMcq`/`computeTotalPoints`/`computeScorePercent`; status `GRADING` when essays present else `GRADED`; `autoSubmitted: true`, sets `submittedAt`/`responses`/`mcqEarned`/`essayEarned`/`totalPoints`/`earnedPoints`/`scorePercent`.
3. `src/controllers/quizController.js`
   - `getQuizMeta`: add `totalQuestions` (from `countQuestions`) and `totalPoints` (from `computeTotalPoints`) to meta.
   - `startQuiz`: pass `bypassPassedCheck = userRole === 'ADMIN'`; include `code: error.code` in error body.
4. **New** `src/controllers/achievementsController.js` + route `GET /user/me/achievements` (add to `src/routes/users.js`, `authenticateToken`).
   - Aggregates per enrolled course: READY bunny videos, completed count, course `completed`, per-quiz `{ videoId, videoTitle, quizTitle, passingScore, maxAttempts, bestScore, passed, attemptsUsed }`.
   - Totals: courses enrolled/completed, videos watched/total, exams taken/passed, avg best score.

## Frontend changes (`L:\E-LRN-FRONTEND\a-e-lrn-frontend`)

5. `types/quiz.ts` — `totalQuestions` / `totalPoints` required on `QuizMetaExists`; add `AchievementsData` interfaces.
6. `app/me/user/subscriptions/page.tsx` + `app/me/user/courses/page.tsx` — add `getEnrolledCourses()` to `services/courseService.ts` (unwrap `enrollment.course`); use it in both pages; links use real `course.id`.
7. `components/quiz/QuizIntroCard.tsx`
   - Real totals; time tile shows `بدون` for untimed.
   - Score badge → `{bestScore}%` (bestScore is already a percent — fixes the misleading `100 / --`).
   - CTA priority: `isLocked` → `hasPassed` (green success, no start) → `outOfAttempts` (exhausted) → normal (with `متابعة الاختبار` label when fresh in-progress).
   - **Remove** `InProgressCountdown`, in-progress timer banner, `useQuizTimer` import.
8. `components/quiz/QuizResultSummary.tsx` — hide "إعادة الاختبار" when `result.passed`.
9. `components/quiz/QuizRunner.tsx`
   - Auto-submit on leave: `beforeunload` + `pagehide` + unmount cleanup (guarded against StrictMode dev ping with `mountedAt > 2s`); fire-and-forget `fetch keepalive` POST `/quizzes/attempts/:id/submit` with `{ answers, autoSubmitted: true }`, `credentials: 'include'` (cookie auth). Single-fire `leaveSubmittedRef`; mark it fired inside `doSubmit` too (prevents double submit after manual submit's router.push).
10. `components/navbar.tsx` — `إنجازاتي` → `/me/user/achievements`; remove dead `بنك الأسئلة` link.
11. `app/me/user/page.tsx` — repoint `نتائج الامتحانات` → `/me/user/achievements`.
12. **New** `app/me/user/achievements/page.tsx` — fetches `/user/me/achievements`, renders totals + per-course progress/exam summary (dark `account-page` styling consistent with subscriptions page).

## Verification

- `node --check` changed BE files.
- `npx tsc --noEmit` in FE.
- Playwright: meta carries real totals; start after pass → 409; `/user/me/achievements` returns aggregates; subscriptions page shows real courses; intro card shows pass success not "exhausted".
- One commit per logical change; user WIP in FE working tree NEVER committed.

## Out of scope

- No schema migration (bestScore is computed; achievements are aggregates). No essay-grading changes. `grades/*` catalog pages unchanged.