# Bug Fix Plan — E-Learning Platform

**Date**: September 2026
**Author**: Staff Software Engineer (Planning Phase)
**Status**: Awaiting Approval

---

## Frontend Context

The frontend lives at `L:\E-LRN-FRONTEND\a-e-lrn-frontend\` — a **Next.js 13 (App Router) + TypeScript** app using Redux Toolkit, SurveyJS, and shadcn/ui.

**Key frontend facts that affect this plan:**
- Frontend uses **BunnyVideo only** — calls `/courses/:id/bunny-videos`, `/videos/:id/playback`, `/progress/*`. Does NOT call legacy Video routes (`/stream/*`, `/videos/course/*`).
- Frontend expects `{ success, data }` envelope — `api-client.ts` auto-unwraps.
- Frontend handles 403 with quiz gate body `{ quizId, previousVideoId, yourScore, requiredScore }` — shows "locked" screen.
- Frontend types: `types/bunny.ts` defines `BunnyVideo`, `types/quiz.ts` defines quiz types.
- Frontend has **no search UI** — no search API calls.
- Frontend has **no assignment file upload** — only text content submitted.
- Frontend sends `grade` in registration form (already required in UI).

**Impact summary**: Most fixes are backend-only. Only 2.1 (position) and 2.2 (quiz retake) may need frontend type updates.

---

## Pre-Planning Assumptions

1. Legacy Video system will be fixed (not deprecated) — both Video and BunnyVideo must work
2. `deleteCourse` must clean up Bunny remote objects (permanent deletion)
3. Essay scoring: MCQ score at submission, essay score added during admin grading
4. BunnyVideo reordering: position field + reorder API
5. Quiz retakes: max 3 attempts per quiz
6. User.grade: required at signup

## Dependencies & Versions

- Node.js: 18+ (Dockerfile uses `node:18-alpine`)
- Prisma: ^5.22.0 (current in package.json)
- Express: ^4.21.2 (current)
- No new dependencies required for any fix

---

## Milestone 1: Critical Bugs (fix immediately)

### 1.1 Fix `previousVideo` undefined in `sequentialAccess.js`

**Problem**: `sequentialAccess.js:76` references `previousVideo` but `evaluateGate` returns `previousVideoId` (a number, not an object). Throws `ReferenceError` at runtime.

**Root Cause**: The code assumes `evaluateGate` returns a video object, but it returns `{ allowed, reason, previousVideoId, quizId, bestScore, required }`.

**Fix**:
- File: `src/middlewares/sequentialAccess.js`
- After `evaluateGate` returns, use `gate.previousVideoId` to query the Assignment model
- Replace `previousVideo.id` with `gate.previousVideoId` in all 4 references (lines 76, 82, 87, 92)

**Verifiable Goal**: `ensureSequentialAccess` no longer throws `ReferenceError` when a legacy Video has a previous video with an assignment.

**Success Criteria**:
- Code compiles without errors
- `previousVideo` variable is never referenced
- All references use `gate.previousVideoId`

**Frontend Impact**: None. Frontend does not use legacy Video routes.

---

### 1.2 Fix `evaluateGate` to work with both Video and BunnyVideo

**Problem**: `evaluateGate` only queries `prisma.bunnyVideo.findUnique()`. Legacy Video IDs won't be found, returning `{ allowed: false, reason: 'Video not found' }`. All legacy Video courses are locked.

**Root Cause**: `evaluateGate` was written for BunnyVideo only and never updated to handle legacy Video.

**Fix**:
- File: `src/services/quizService.js`
- In `evaluateGate`, first try `bunnyVideo.findUnique`. If not found, try `video.findUnique`
- If legacy Video found, get courseVideos from `prisma.video.findMany()` (using `position` ordering)
- Gate logic remains the same: check previous video completion, quiz pass, exemption
- For legacy Videos, check `VideoProgress` instead of `BunnyVideoProgress`

**New helper function**: `evaluateGateForLegacyVideo(userId, videoId, userRole)`
- Queries `video.findUnique` with course
- Gets `courseVideos` ordered by `position asc, id asc`
- Checks previous video completion via `videoProgress.findFirst`
- Checks quiz pass (if quiz exists for that video — currently quizzes only on BunnyVideo, so this is a no-op for legacy)
- Returns same shape as `evaluateGate`

**Modify `evaluateGate`**: Try BunnyVideo first, fall back to legacy Video.

**Verifiable Goal**: A student enrolled in a course with only legacy Videos can access videos sequentially (first video always, subsequent after completing previous).

**Success Criteria**:
- `evaluateGate` works with both Video and BunnyVideo IDs
- Legacy Video sequential access checks `VideoProgress` completion
- Admins still bypass all checks
- No regression for BunnyVideo courses

**Frontend Impact**: None. Frontend only uses BunnyVideo routes. Legacy Video fix is backend-only.

---

### 1.3 Fix `deleteCourse` to clean up Bunny remote

**Problem**: `deleteCourse` in `coursesController.js` deletes DB rows but never calls `bunnyClient.deleteVideo()`. Orphaned videos on Bunny servers cost money.

**Root Cause**: The transaction only handles Prisma deletes, not external API calls.

**Fix**:
- File: `src/controllers/coursesController.js`
- Before the Prisma transaction, fetch all `BunnyVideo` records for the course
- After the transaction succeeds, call `bunnyClient.deleteVideo()` for each
- If Bunny deletion fails, log warning but don't fail the request (DB is already cleaned)
- Import `bunnyClient` from `src/integrations/bunny/bunnyStreamClient.js`

**New helper**: `cleanupBunnyVideos(courseId)`
- Fetches BunnyVideos for course
- Calls `bunnyClient.deleteVideo(bunnyVideoId)` for each
- Catches and logs errors per-video (isolation)
- Returns count of deleted videos

**Verifiable Goal**: Deleting a course removes both DB records and Bunny remote objects. No orphaned videos remain.

**Success Criteria**:
- Course deletion calls `bunnyClient.deleteVideo()` for each BunnyVideo
- Bunny deletion errors are caught and logged (don't fail the request)
- DB transaction still rolls back on Prisma errors
- Legacy Videos (URL-based) are not affected (no Bunny objects to delete)

**Frontend Impact**: None. Course deletion is an admin-only backend operation.

---

### 1.4 Fix `submitAttempt` dead code ternary

**Problem**: Lines 404-405 in `quizService.js`:
```js
const earnedPoints = hasEssays ? mcqEarned : mcqEarned;
const scorePercent = hasEssays ? computeScorePercent(mcqEarned, totalPoints) : computeScorePercent(mcqEarned, totalPoints);
```
Both branches are identical. Essay score is always 0 at submission.

**Root Cause**: The ternary was meant to add essay points, but essays are graded later. The code is correct in intent (MCQ only at submission) but confusingly written.

**Fix**:
- File: `src/services/quizService.js`
- Simplify to direct assignment (no ternary):
  ```js
  const earnedPoints = mcqEarned;
  const scorePercent = computeScorePercent(mcqEarned, totalPoints);
  ```
- Add comment explaining: "Essay points are added during admin grading via gradeEssayAttempt"

**Verifiable Goal**: `submitAttempt` calculates MCQ score correctly. Essay questions contribute 0 at submission time. Essay score is added during `gradeEssayAttempt`.

**Success Criteria**:
- No ternary with identical branches
- MCQ score calculated correctly
- Essay score remains 0 until admin grades
- `gradeEssayAttempt` still works correctly (adds essay points to existing score)

**Frontend Impact**: None. Frontend reads `scorePercent` from quiz result — format unchanged.

---

## Milestone 2: Schema/Design (fix before launch)

### 2.1 Add `position` field to BunnyVideo + reorder API

**Problem**: `BunnyVideo` has no `position` field. Videos ordered by `createdAt` only. Cannot reorder.

**Fix**:

**Step 1: Schema migration**
- File: `prisma/schema.prisma`
- Add `position Int?` to `BunnyVideo` model
- Run `npx prisma migrate dev --name add_bunny_video_position`

**Step 2: Update video creation**
- File: `src/services/bunnyVideoService.js`
- When creating a BunnyVideo, set `position` to `max(position) + 1` for the course
- Or accept `position` in request body and shift existing positions

**Step 3: Reorder API**
- File: `src/routes/bunnyVideoRoutes.js`
- Add `PATCH /courses/:courseId/reorder` (admin only)
- Request body: `{ videoIds: [3, 1, 2, 4] }` (ordered array of BunnyVideo IDs)
- Update `position` for each video based on array index
- Return updated ordered list

**Step 4: Update ordering queries**
- Files: `src/services/quizService.js`, `src/services/bunnyVideoService.js`
- Change `orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]` to `orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }]`

**Verifiable Goal**: Admin can reorder BunnyVideos. Students see videos in the admin-defined order.

**Success Criteria**:
- `BunnyVideo.position` field exists in schema
- New videos get auto-assigned position
- `PATCH /courses/:courseId/reorder` updates positions
- `evaluateGate` and `listCourseVideos` order by position

**Frontend Impact**: 
- `types/bunny.ts` — add `position?: number | null` to `BunnyVideo` type
- `bunnyVideoService.fetchBunnyCourseVideos` — response already returns ordered array, no change needed
- Admin reorder UI is optional (future work) — backend API is ready

---

### 2.2 Add quiz retake logic (max 3 attempts)

**Problem**: No max attempts, no retake flow. `startAttempt` resumes existing `IN_PROGRESS` attempts.

**Fix**:

**Step 1: Schema change**
- File: `prisma/schema.prisma`
- Add `maxAttempts Int @default(3)` to `Quiz` model
- Run `npx prisma migrate dev --name add_quiz_max_attempts`

**Step 2: Update startAttempt**
- File: `src/services/quizService.js`
- Before creating new attempt, count `GRADED` attempts for this user+quiz
- If count >= `quiz.maxAttempts`, return error: "Maximum attempts reached"
- If `IN_PROGRESS` attempt exists and not expired, resume it (current behavior)
- If `IN_PROGRESS` attempt is expired, mark as `EXPIRED` and allow new attempt

**Step 3: Update gate evaluation**
- `evaluateGate` uses `findFirst` with `orderBy: { scorePercent: 'desc' }` — this already picks the best score. No change needed.

**Verifiable Goal**: Students can attempt a quiz up to 3 times. Best score counts for gate evaluation. After 3 attempts, they cannot start a new one.

**Success Criteria**:
- `Quiz.maxAttempts` field exists (default 3)
- `startAttempt` checks attempt count before creating new attempt
- Error returned when max attempts reached
- Expired attempts don't count toward limit
- Best score still used for gate evaluation

**Frontend Impact**:
- `types/quiz.ts` — add `maxAttempts?: number` to `QuizMeta` type
- `QuizIntroCard` — display "X of 3 attempts used" if `maxAttempts` present
- Handle new error response: `{ success: false, error: "Maximum attempts reached" }` (409)
- `StudentAttemptsData.attempts[]` — already has `attemptNumber`, no change needed

---

### 2.3 Make `User.grade` required at signup

**Problem**: `User.grade` is optional but required for recommendations. Students without grade get nothing.

**Fix**:

**Step 1: Schema change**
- File: `prisma/schema.prisma`
- Change `grade Grade?` to `grade Grade` (remove `?`)
- Run `npx prisma migrate dev --name make_user_grade_required`

**Step 2: Update registration validation**
- File: `src/controllers/authController.js`
- Add validation: `grade` must be one of `FIRST_SECONDARY`, `SECOND_SECONDARY`, `THIRD_SECONDARY`
- Return 400 if missing or invalid

**Step 3: Update existing users (data migration)**
- Write a one-time script to set default grade for existing users without one
- Default: `FIRST_SECONDARY` (safest assumption)

**Verifiable Goal**: All new registrations require a grade. Existing users have a default grade.

**Success Criteria**:
- `User.grade` is non-nullable in schema
- Registration rejects requests without valid grade
- Existing users without grade get `FIRST_SECONDARY`
- Recommendations work for all students

**Frontend Impact**: None. Frontend already sends `grade` in registration form (required in UI). Backend validation now enforces it.

---

### 2.4 Update README

**Problem**: README is completely stale — wrong roles (mentions TEACHER), wrong quiz model (mentions `description`), outdated instructions.

**Fix**:
- File: `README.md`
- Remove references to TEACHER role (only STUDENT and ADMIN exist)
- Update quiz section to describe SurveyJS system (not old Question/Answer model)
- Update installation instructions (remove `npm start`, use `npm run dev`)
- Add Bunny Stream configuration section
- Remove YouTube integration section (dead code)
- Add known limitations section

**Verifiable Goal**: README accurately reflects the current state of the codebase.

**Success Criteria**:
- No mention of TEACHER role
- Quiz section describes SurveyJS, `surveyJson`, `answerKey`
- Installation uses `npm run dev` not `npm start`
- Bunny Stream setup documented
- YouTube section removed

---

## Milestone 3: Dead Code (clean up)

### 3.1 Remove `testImports.js`

**Problem**: References non-existent `youtubeRoutes`. Stale script.

**Fix**: Delete `scripts/testImports.js`

**Verifiable Goal**: No stale test scripts referencing removed modules.

---

### 3.2 Remove `getCookieConfig()` from `utils.js`

**Problem**: Never imported anywhere. Dead code.

**Fix**: Remove `getCookieConfig` function and its export from `src/utils.js`

**Verifiable Goal**: No unused exports in utility files.

---

### 3.3 Review empty placeholder files

**Problem**: `videoProcessing.js` and `videoProcessingController.js` are empty.

**Fix**: Delete both files if no imports reference them. Check with grep first.

**Verifiable Goal**: No empty placeholder files in the codebase.

---

## Execution Order

```
Milestone 1 (Critical Bugs)
  1.1 → 1.2 → 1.3 → 1.4
  
Milestone 2 (Schema/Design)
  2.3 → 2.1 → 2.2 → 2.4
  
Milestone 3 (Dead Code)
  3.1 → 3.2 → 3.3
```

**Note**: 2.3 (User.grade) comes before 2.1 (BunnyVideo position) because it's a schema change that affects data integrity. 2.1 involves a migration that should be done after data is clean.

---

## Risk Assessment

| Fix | Risk | Mitigation |
|-----|------|------------|
| 1.1 previousVideo | Low — simple variable reference fix | Test with legacy Video course + assignment |
| 1.2 evaluateGate dual-system | Medium — new code path for legacy Video | Test both Video and BunnyVideo courses |
| 1.3 deleteCourse Bunny cleanup | Low — additive, error-isolated | Test course with BunnyVideos, verify deletion |
| 1.4 submitAttempt ternary | Low — simplification only | Verify MCQ scoring still works |
| 2.1 position field | Medium — schema migration + reorder API | Test with existing courses, verify ordering |
| 2.2 quiz retake | Medium — new business logic | Test attempt counting, max limit, expired handling |
| 2.3 User.grade required | Low — schema change + data migration | Migrate existing users, test registration |
| 2.4 README | None — documentation only | Review for accuracy |
| 3.x dead code | Low — deletion only | Grep for imports before deleting |

---

## Frontend Changes Required

| Fix | Frontend Change | Files |
|-----|----------------|-------|
| 2.1 BunnyVideo position | Add `position` to `BunnyVideo` type | `types/bunny.ts` |
| 2.2 Quiz retake | Add `maxAttempts` to `QuizMeta`, display attempt count, handle 409 error | `types/quiz.ts`, `components/quiz/QuizIntroCard` |

All other fixes are backend-only — no frontend changes needed.

---

## Milestones (Verifiable Goals)

| Milestone | Goal | Verification |
|-----------|------|--------------|
| M1 | All 4 critical bugs fixed | Manual test: legacy Video sequential access, course deletion with Bunny cleanup, quiz submission |
| M2 | Schema updated, new features working | Manual test: video reordering, quiz retake limit, grade required at signup |
| M3 | Dead code removed | Grep confirms no references to deleted files/functions |

---

**Awaiting approval to begin execution.**
