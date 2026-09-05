# Quiz Feature + Gate Integration Test Plan (Sept 2026)

Status: **EXECUTED — ALL 24 ASSERTIONS PASSED** (Phases A + B green; Phase C pending Chromium install)
Target: `scripts/testQuizFlow.js` (separate from `scripts/uploadDemoVideos.js`).

## Grilling answers (locked)

- Q1 Fresh student? → **Yes** — new `seqquiz@localhost.test`, zero progress, wiped per run.
- Q2 Include a deliberate fail? → **Yes** — B6 (50% fail) before the pass attempt; B14 fails once too.
- Q3 Test essay path now? → **Yes** — Phase B validates the admin-grading requirement end-to-end.
- Q4 API first or browser first? → **API first**; Playwright (Phase C) only after A/B green.
- Q5 Shared or separate script? → **Separate** `scripts/testQuizFlow.js`.

## Environment (verified live)

- Backend `http://localhost:3005` UP, running round-1 code (cookie-only auth, structured codes, unlock precondition, click-to-burn fix).
- FE `http://localhost:3000` UP (Next.js, Arabic RTL). Playwright Chromium NOT yet installed.
- Course #1 "Sequential Access Test Course": videos 1/2/3 READY (positions 1–3).

## Contract (confirmed from code)

- **Gate unlock** for video N: previous video completed AND previous quiz passed (or no quiz / exemption). `quizService.evaluateBunnyVideoGate` at `src/services/quizService.js:243`. Evaluated on `playback` → 403 `{ code: 'SEQUENTIAL_GATE', quizId, yourScore, requiredScore, previousVideoId }`.
- **`meta.unlocked` ≠ cross-video gate.** It means *own video completed* (quiz becomes startable after watching that video). `start` enforces it too ("complete the video to start the quiz"). Cross-video gating exists only on `playback`/`complete`.
- **Meta shape** (`GET /quizzes/videos/:id/meta`): `{ exists, quizId, videoId, title, timeLimitSec, passingScore, maxAttempts, attemptsUsed, atMaxAttempts, unlocked(own-video), attempted, totalAttempts, passed, bestScore, inProgressAttempt }`.
- **Start** (`POST /quizzes/videos/:id/start`): `{ attemptId, attemptNumber, status, startedAt, deadlineAt, resumed, responses, quiz }`. `quiz.surveyJson` is sanitized — **NO `answerKey`** (verified B5).
- **Submit** (`POST /quizzes/attempts/:id/submit`): `{ attemptId, status:'GRADED'|'GRADING', earnedPoints, totalPoints, scorePercent, hasEssays, perQuestion[] }`. **No `passed` field** — FE `SubmitQuizData` doesn't declare one either; pass/fail is derived from `meta`/`result` (verified safe, not a contract bug).
- **Result** (`GET /quizzes/attempts/:id/result`): post-grade `{ status, passed, scorePercent, questions[], ... }`; correctAnswer/feedback only visible after submission.
- **Attempts**: `maxAttempts` default 3; EXPIRED attempts don't burn a retake; 4th `start` → 409 `"You have used all 3 allowed attempts for this quiz"`.
- **Grading** (`PUT /quizzes/attempts/:id/grade`, admin): `{ essayScores: {qName: number}, essayFeedback?: {qName: string} }`.

## Execution results (Phase A + B)

24/24 assertions passed on the live backend. Highlights:

- **B4** video completion alone does NOT unlock the next video (playback still 403) — quiz-gate coupling proven.
- **B10** completion + quiz pass → playback v2 200 (`★` money assertion).
- **B5** no answerKey leak in the student-facing surveyJson.
- **B17–B20** essay → GRADING → admin GRADING queue → grade → GRADED 80% with feedback. Confirms an essay quiz **cannot pass without admin grading** (documented UX gap until an AI-grader).
- **B21** retake limiter: 3 fails used up, 4th start → 409.

Caveats discovered:
- Rate limiting (100 req/15min on 3005) is easy to trip in dev; restart the backend to clear it.
- `seqaccess@localhost.test` is now blocked on v2/v3 until its quizzes are passed (quizzes now exist on v1/v2) — expected.

## Remaining

- **Phase C (Playwright):** install Chromium first (`cd C:\Users\Ahmed Saied\.agents\skills\playwright-skill && npm run setup`), then browser flow: login as `seqquiz@localhost.test` → course #1 → watch video → pass quiz in SurveyJS UI → next video unlocks. Screenshots to `PW_ARTIFACT_DIR`.

## Re-running

```bash
node scripts/testQuizFlow.js   # requires backend up; wipes test-student state each run
```