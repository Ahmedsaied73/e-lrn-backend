# Plan: Quiz Feature Rebuild (SurveyJS-based) — Backend API

## Summary
Rip out the legacy Quiz system (3 models, 2 files, 4 external dependents) completely, then rebuild a secure, reusable quiz API on **SurveyJS JSON** as the question-definition format: video-gated quizzes with a single countdown timer, single-answer MCQ (auto-graded) + essays (admin-graded against stored model answers), a hard **≥50%** score gate for sequential video access, and an **admin override** to advance students without passing. This repo is **backend-only** — the API serves/stores validated SurveyJS JSON; the React frontend (survey-creator for admins, survey-react-ui for students) integrates via the documented contract. **Zero new npm dependencies required.**

## Decisions Locked (user-confirmed)
| Question | Decision |
|---|---|
| Frontend scope | API only in this repo; design doc includes frontend integration contract |
| Authoring | Frontend uses official **survey-creator**; backend stores/validates its JSON output |
| Next-video gate | **Hard gate**: previous video completed AND its quiz scored ≥50%; plus admin endpoint to force-advance a student |
| MCQ | **Single-answer only** (SurveyJS `radiogroup`) |
| Essays | Admin grades manually; each essay has a stored **model answer**; AI grading deferred (design leaves seam for it) |
| Timer expiry | Client auto-submits; server enforces deadline + ~10s network grace; missed deadline ⇒ attempt expires at 0 |

## Assumptions (flagged, not silently made)
1. Quizzes attach to **videos only** (legacy also supported course-level final exams — not in new requirements; noted as future extension).
2. **One attempt** per user per quiz (matches legacy one-shot `@@unique([userId, questionId])` spirit). Admin gets a *reset attempt* endpoint, otherwise failed students would be permanently stuck.
3. Videos **may have no quiz** — gate then requires only video completion (quiz presence is optional per video).
4. Quiz definition edits/deletes are **blocked once any attempt is submitted** (409) — avoids answer-key versioning complexity.
5. Admins bypass all gates (existing codebase convention).
6. `passingScore` defaults to 50, stored per-quiz for future flexibility.

---

## Current-State Audit (verified line-exact)

### Legacy quiz artifacts (to REMOVE)
| Artifact | Location | Action |
|---|---|---|
| `Quiz`, `Question`, `Answer` models | prisma/schema.prisma L167–214 (+ back-relations `User.quizAnswers` L23, `Course.quizzes` L46, `Video.quizzes` L66, BunnyVideo comment L289) | Delete blocks + lines |
| Quiz route mount | app.js L14 (`require`), L109 (`app.use('/quizzes', ...)`) | Delete lines |
| Controller + routes | src/controllers/quizController.js, src/routes/quizRoutes.js | Delete files |
| Quiz gate in next-video logic | src/controllers/nextVideoController.js L64–126 (`prisma.quiz.findFirst` → 403 unless passed) | Delete block |
| Quiz gate in streaming access | src/middlewares/sequentialAccess.js L79–141 (same gate on `/stream/video/:id/url` + `/embed`) | Replace with new gate (Phase 6); temporarily delete block in Phase 1 |
| Manual cascade in admin script | scripts/deleteCourse1.js L14, L24, L31–39, L53–61 | Remove quiz blocks (DB FK cascade covers rest) |
| Historical migrations | 20250501035227_adding (creates tables), 20260805144156_ (renames FK indexes to `Quiz_courseId_idx`/`Quiz_videoId_idx`) | Never touch history; new drop migration only |
| Docs | README.md L13/L17/L67/L72–74; API_DOCUMENTATION.md L248–255; API-DOCUMENTATION.md L1028–1897 | Update/remove sections |
| Prior audit specs referencing quiz | .trae/specs/audit-codebase-review/* | Leave untouched (historical record) |

### Verified clean (NO quiz references — no changes needed)
accessControl.js, videoProgressController.js, coursesController.js (progress % uses VideoProgress only), searchController.js, assignmentController.js (separate Assignment* feature — do NOT touch), streamRoutes.js, bunnyVideoService.js, certificates/notifications (none exist).

### Video-completion signal (gate input — unchanged)
`VideoProgress.completed` boolean (schema L154–165, unique `[userId, videoId]`), set by POST /progress/complete (videoProgressController.js L57–73). Read consumers: sequentialAccess.js L64–77, nextVideoController.js L49–62, getCourseById includes. These stay intact; new gate logic plugs alongside.

---

## Target Architecture

### Data model (new migration)
```prisma
model Quiz {
  id           Int      @id @default(autoincrement())
  videoId      Int      @unique          // one quiz per video
  title        String
  timeLimitSec Int?                       // null = untimed
  passingScore Int      @default(50)     // percent
  surveyJson   Json                       // SurveyJS form definition (student-safe)
  answerKey    Json                       // SERVER-ONLY: {qName: {type:"radiogroup"|"comment", correctValue?, modelAnswer?, points}}
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  video        Video    @relation(fields:[videoId], references:[id], onDelete: Cascade)
  attempts     QuizAttempt[]
  @@index([videoId])
}

model QuizAttempt {
  id            Int       @id @default(autoincrement())
  quizId        Int
  userId        Int
  status        String    @default("IN_PROGRESS") // IN_PROGRESS|SUBMITTED|GRADING|GRADED|EXPIRED
  startedAt     DateTime  @default(now())
  deadlineAt    DateTime?                          // server-authoritative timer
  submittedAt   DateTime?
  autoSubmitted Boolean   @default(false)
  responses     Json?                                // {qName: value} snapshot
  mcqEarned     Int?        totalPoints Int?  earnedPoints Int?
  scorePercent  Float?
  essayGradedBy Int?        essayGradedAt DateTime?
  quiz          Quiz      @relation(fields:[quizId], references:[id], onDelete: Cascade)
  user          User      @relation(fields:[userId], references:[id])
  @@unique([userId, quizId])                      // one attempt; admin reset = row delete
  @@index([quizId]) @@index([userId])
}

model GateExemption {                             // admin override: skip quiz gate for (user, video-with-quiz)
  id        Int      @id @default(autoincrement())
  userId    Int
  videoId   Int                                    // the video OWNING the waived quiz
  grantedBy Int
  reason    String?
  createdAt DateTime @default(now())
  user      User     @relation(fields:[userId], references:[id])
  @@unique([userId, videoId]) @@index([videoId])
}
// + back-relations: Video.quiz Quiz?, User.quizAttempts / gateExemptions
```

### Code layout (reusable, layered — mirrors existing bunny pattern)
```
src/config/quizConfig.js        // constants: GRACE_SEC=10, MAX_SURVEY_JSON_BYTES=262144, ALLOWED_TYPES=['radiogroup','comment'], statuses
src/services/quizService.js     // ALL logic, framework-free & reusable:
                                //   validateSurveyJson(json) → {ok, errors} (size cap, type whitelist, unique element names, pages present)
                                //   buildAnswerKey(surveyJson, keyInput) → answerKey (correct values NEVER stored in surveyJson)
                                //   sanitizeForStudent(quiz) → strips answerKey via select whitelist
                                //   gradeMcq(answerKey, responses) → {mcqEarned,totalPoints,perQuestion[]}
                                //   computeFinalScore(attempt, essayAwards) → pure score math
                                //   evaluateGate(userId, videoId) → {allowed, reason}  ← SINGLE SOURCE OF TRUTH reused by BOTH
                                //     sequentialAccess middleware and nextVideoController (kills today's duplicated gate logic)
                                //   startAttempt / submitAttempt / gradeAttempt (transactional DB ops)
src/controllers/quizController.js   // thin HTTP adapters only (auth context → service → res)
src/routes/quizRoutes.js            // declarative Express router (replaces deleted file)
```

### API contract (all under mount `/quizzes`; JWT cookie auth; envelope `{success,data|error}`)
**Student** (enrolled+paid verified; admin bypass):
| Method/Path | Purpose |
|---|---|
| GET `/quizzes/videos/:videoId/meta` | Drives “بدء الاختبار” button: `{exists, unlocked(video completed?), attempted, passed, scorePercent, remainingSec}` |
| POST `/quizzes/videos/:videoId/start` | Creates/resumes attempt → `{attemptId, surveyJson, deadlineAt}` (409 if already GRADED/EXPIRED; returns existing IN_PROGRESS) |
| POST `/quizzes/attempts/:id/submit` | Body `{answers, autoSubmitted?}`; rejected 403 after `deadlineAt+10s`; instant MCQ grading; status GRADING if essays exist else GRADED |
| GET `/quizzes/attempts/:id/result` | Per-question correctness/score/model-answer-reference AFTER submit only |

**Admin** (`authorizeAdmin()`):
| Method/Path | Purpose |
|---|---|
| POST `/quizzes/videos/:videoId` | Upsert definition: `{title,timeLimitSec,surveyJson,answerKey}` — validated by quizService |
| PUT `/quizzes/:quizId` · DELETE `/quizzes/:quizId` | Edit/remove — 409 once attempts submitted |
| GET `/quizzes/:quizId/attempts?status=` | Grading queue incl. essay responses + model answers |
| PUT `/quizzes/attempts/:id/grade` | `{essayScores:{qName:pts}}` → recomputed scorePercent, status GRADED |
| POST `/quizzes/attempts/:id/reset` | Deletes attempt → student may retake |
| POST `/quizzes/videos/:videoId/exemptions` / DELETE `/quizzes/exemptions/:exemptionId` | Grant/revoke GateExemption (force-advance) |

### Gate semantics (evaluateGate — replaces both legacy blocks)
Access video N ⇔ admin ‖ GateExemption(user, N-1) ‖ [ VideoProgress(N-1).completed ∧ ( noQuiz(N-1) ∨ attempt.scorePercent ≥ quiz.passingScore ) ]. Untimed quizzes: no deadline. Expired IN_PROGRESS attempts swept to EXPIRED (score 0) lazily on read + via existing cron pattern.

### Security checklist (baked into phases)
answerKey excluded at Prisma-select level; attempt ownership enforced; server-side timer/completion/enrollment checks (never trust client); strict JSON validation caps; P2002→409 handling; rate-limited start/submit via existing limiter conventions; admin-only mutations; no raw error leakage (existing handler).

---

## Phased Implementation TODO

### Phase 0 — Baseline
- [ ] 0.1 Boot check `node app.js`; record healthy endpoints (courses/stream/progress) for regression comparison.

### Phase 1 — Legacy removal (app functional after every step)
- [ ] 1.1 Edit app.js (L14, L109), nextVideoController.js (L64–126), sequentialAccess.js (L79–141 → completion-only gate remains), deleteCourse1.js quiz blocks.
- [ ] 1.2 Delete src/controllers/quizController.js, src/routes/quizRoutes.js.
- [ ] 1.3 Schema surgery: remove 3 models + 3 back-relation lines + fix BunnyVideo comment; new migration `drop_legacy_quiz` (`DROP TABLE Answer; Question; Quiz;` in FK-safe order); `prisma generate`.
- [ ] 1.4 Verify: boot OK; `grep -ri "prisma.quiz\|prisma.question\|prisma.answer\b"` over src/ = 0 hits; stream/progress/courses curls pass.
- [ ] 1.5 Update README.md + API_DOCUMENTATION.md + API-DOCUMENTATION.md (remove quiz sections).

### Phase 2 — Data foundation
- [ ] 2.1 Add Quiz/QuizAttempt/GateExemption models + back-relations; migration; generate; `prisma validate`.

### Phase 3 — Core service (pure, unit-checkable)
- [ ] 3.1 quizConfig.js + quizService.js: validators, buildAnswerKey, gradeMcq, score math, evaluateGate, attempt ops ($transaction on submit).
- [ ] 3.2 Self-check script scripts/testQuizLogic.js (assert-style, mirrors repo’s script conventions).

### Phase 4 — Student API
- [ ] 4.1 Controller + student routes wired in app.js (`/quizzes` mount restored).
- [ ] 4.2 Curl-matrix verify: non-enrolled 403, uncompleted video lock, happy path start→submit→GRADED, essay path →GRADING, late submit 403, double-start resumes, answerKey absent from all responses.

### Phase 5 — Admin API
- [ ] 5.1 Authoring CRUD + validation errors (bad type/oversized/duplicate names → 400).
- [ ] 5.2 Grading queue + grade endpoint (score recompute correct; status transitions).
- [ ] 5.3 Exemptions grant/revoke + attempt reset (idempotency, 409 paths).

### Phase 6 — Gating integration (reuse evaluateGate)
- [ ] 6.1 Rewire sequentialAccess.js + nextVideoController.js onto quizService.evaluateGate (completion ∧ quiz-pass ∨ exemption).
- [ ] 6.2 End-to-end: fail(<50%) blocks next video/url+embed; pass(≥50%) unlocks; exemption unlocks; admin bypass intact.

### Phase 7 — Docs/handoff
- [ ] 7.1 Write repo-root QUIZ_FEATURE_DESIGN.md: this design + frontend integration contract (survey-creator → POST payload shape; survey-react-ui render from start endpoint; timer/auto-submit client duties; Arabic “بدء الاختبار” driven by /meta).
- [ ] 7.2 Final sweep: grep-zero legacy refs; full boot + smoke matrix green.

## Verification Strategy
No test framework in repo (consistent with codebase): assert-based node scripts + structured curl matrices per phase; `npx prisma validate`/migrate; boot checks each phase; final end-to-end script scripts/testQuizFlow.js covering the Phase 6 matrix.

## Risks & Mitigations
| Risk | Mitigation |
|---|---|
| Hidden quiz consumer crashes post-drop | Exhaustive grep audit done (list above); Phase 1.4 re-greps before rebuild |
| Sequential-access regression | evaluateGate is single shared impl; Phase 6 dedicated matrix |
| Students stranded by failed one-shot attempt | Reset-attempt + exemption endpoints |
| SurveyJS JSON drift/bloat | Whitelist validation + byte cap + type constraints |
| Timer tampering | deadlineAt server-set; grace window; lazy expiry sweep |
