# EXAM_CREATION_AUDIT.md — Audit Report

## Phase 0: Diagnosis of Initial Error

### 1. Reproduction & Exact Error
When sending the admin request:
> "عايزك تعملي امتحان لاول فيديو موجود في كورس النحو الوحدة الثانيه و تعمله عشر اسئله منها خمسه MCQ و الخمسه الباقيين مقالي و تخلي قابل انه يتصحح بالai"

The agent failed with:
`{"ok": false, "code": "LLM_ERROR", "message": "حصل خطأ أثناء توليد الرد. جرّب تاني، ولو كررت نفسها راجع إعدادات مزوّد الذكاء الاصطناعي."}`

Underlying backend exception stack trace (reproduced in `scripts/trace-turn.js`):
```text
Error: [GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/openai/gpt-oss-120b:generateContent: [404 Not Found]
    at handleResponseNotOk (node_modules/@google/generative-ai/dist/index.js:434:11)
    at async makeRequest (node_modules/@google/generative-ai/dist/index.js:403:9)
    at async generateContent (node_modules/@google/generative-ai/dist/index.js:867:22)
    at async chat_models.cjs:628:12
    at async invokeWithFailover (src/services/agent/llmProvider.js:327:22)
```

### 2. Root Cause Classification
- **Cause**: Combination of:
  1. Primary model `gemini-3.6-flash` suffered a transient 503 spike (`[503 Service Unavailable] This model is currently experiencing high demand`).
  2. `llmProvider.js` attempted failover to `fallbackModel`, configured in `.env` as `AI_AGENT_MODEL_FALLBACK="openai/gpt-oss-120b"`. Because Gemini is the sole active provider (`DEFAULT_PROVIDER_ORDER = ['gemini']`), `createModel` instantiated `@langchain/google-genai` with model `openai/gpt-oss-120b`.
  3. Google Generative AI rejected this invalid Gemini model with `404 Not Found`.
  4. In `src/services/agent/llmProvider.js:54`, `MODEL_GONE_404_RE` did not match `[404 Not Found]`, causing `classifyFailure()` to treat it as a permanent client request error (`kind: 'request'`), throwing the raw 404.
  5. In `src/services/agent/agentService.js:413`, `err.code !== 'ALL_PROVIDERS_FAILED'` caught the thrown error and returned the generic UI error.

### 3. Phase 0 Fixes Applied
1. **Model Configuration**:
   - Updated `.env`:
     - `AI_AGENT_MODEL_PRIMARY="gemini-3-flash-preview"` (tested: latency ~3.6s, 200 OK)
     - `AI_AGENT_MODEL_FALLBACK="gemini-3.1-flash-lite"` (tested: latency ~2.5s, 200 OK)
   - Updated `src/config/env.js:275-276` defaults to `'gemini-3-flash-preview'` and `'gemini-3.1-flash-lite'`.
2. **Error Pattern Matching in `llmProvider.js:54`**:
   - Added `\[404 Not Found\]` to `MODEL_GONE_404_RE`.
3. **Structured Error Categorization in `agentService.js:413-435`**:
   - Differentiates `rate_limited` (429/quota), `provider_config` (404/model), and `auth_error` (401), returning descriptive Arabic messages to the admin while preserving `code: 'LLM_ERROR'` contract.

---

## Phase 1: Audit Table

| Item | EXISTS? | WORKS CORRECTLY? | EVIDENCE | GAP |
| :--- | :--- | :--- | :--- | :--- |
| **A.1 Course Lookup by Name** | PARTIALLY | NO | `src/services/agent/tools/courses.js:34-76` (`courses_list`) only filters by `grade` with `take` up to 50. No `search` argument, no Arabic normalization (diacritics, hamzas, ة/ه, ى/ي). | Cannot search courses by query "النحو". Returns list of 50 courses; if course is not in first 50 or query is ambiguous, model guesses or fails. |
| **A.2 Unit / Course Units Resolution** | NO | NO | `prisma/schema.prisma:10-50` has no `Unit` model. Courses represent units in title/description (e.g. Course 128: "النحو الوحدة الثانية الصف الثالث الثانوي"). `course_detail` (`courses.js:78-140`) returns only counts `videos: { total, ready }`. | Agent cannot inspect course structure or unit grouping. |
| **A.3 Video Resolution by Real Order** | PARTIALLY | NO | `prisma/schema.prisma:15` has `position Int?` on `BunnyVideo`. Only tool returning videos is `video_engagement` (`courses.js:374-445`), which queries `bunnyVideoProgress` ordered by `viewers desc` (not `position`). Videos with 0 views are omitted entirely. | No tool lists videos of a course by sequence (`position` / `createdAt`). Agent cannot deterministically pick "أول فيديو". |
| **A.4 Ambiguity / No Match Handling** | NO | NO | `courses_list` returns `{ rows, returned, truncated }`. `course_detail` returns `{ found: false }`. | Neither tool returns structured ambiguous match candidates (e.g. `{ ambiguous: true, candidates: [...] }`) to guide admin dialogue. |
| **B.1 Quiz Creation Tool Existence** | PARTIALLY | NO | `src/services/agent/tools/actions.js:390-440` (`upsert_quiz`). Expects raw SurveyJS definition (`surveyJson`) and server `answerKey` objects. | No friendly `create_quiz` tool accepting a question array `[{ type, text, points, options, correctOption, modelAnswer, rubric, aiGrading }]`. Model cannot reliably generate valid SurveyJS JSON schemas on the fly. |
| **B.2 Mixed Question Types (MCQ + Essay)** | YES (in backend) / NO (in agent schema) | NO | Backend `quizService.js:85-130` supports `radiogroup` (MCQ) and `comment` (essay). `upsert_quiz` schema declares `surveyJson: z.record(...)` and `answerKey: z.record(...)`. | Agent schema does not define typed question objects; Gemini is forced to invent raw SurveyJS payload format. |
| **B.3 Video Attachment & Default Status** | YES | YES | `prisma/schema.prisma:120-135` (`Quiz.bunnyVideoId @unique`). `upsert_quiz` attaches to `bunnyVideo.slug`. Quiz has no draft/review status column; default is active immediately. | None. Attached via `bunnyVideoId`. Active by default. |
| **C.1 AI-Grading Flag on Essay** | YES (in backend) / NO (in agent tool) | PARTIALLY | Backend `quizService.js:125-130` checks `entry.ai && entry.ai.enabled === true`. `upsert_quiz` does not expose an explicit AI-grading flag for questions. | Agent must manually inject `{ ai: { enabled: true } }` into raw `answerKey` JSON without schema guidance. |
| **C.2 AI Grading Pipeline Execution** | YES | YES | `quizService.js:838-839` triggers `enqueueAiGradingSafe(attemptId)` on `STATUS.GRADING`. `src/services/aiGrader/queue.js:133-159` adds BullMQ job. Worker `src/services/aiGrader/worker.js:120-140` executes `gradeEssay()`. | Pipeline executes when Redis is enabled and queue is active. |
| **C.3 Score Auto-Publish & Teacher Review** | **CRITICAL FAILURE** | **NO** | `src/services/aiGrader/worker.js:128` calls `quizService.applyAiVerdict()`. `src/services/quizService.js:1053-1065` updates attempt to `status: STATUS.GRADED` and calls `notifyGradedSafe(updated.id)`. Student immediately sees score via `getAttemptResults` (`quizController.js:419`). | **STOP CONDITION HIT**: AI grading auto-finalizes and publishes score to student without teacher review! |
| **C.4 criteriaBreakdown Storage** | PARTIALLY | NO | `aiGrader/worker.js:98` stores `verdict.criteriaBreakdown` in `AiGradingJob.verdict`. But `quizService.js:1037-1045` only stores `{ awarded, max, feedback, gradedBy, confidence, model, promptVersion, gradedAt }` in `QuizAttempt.essayFeedback`. | `criteriaBreakdown` is omitted from `QuizAttempt.essayFeedback`. |
| **D.1 Question Counts Validation** | NO | NO | Neither `validateSurveyJson` nor `buildAnswerKey` (`quizService.js:35-130`) checks expected question counts or split (e.g. 5 MCQ + 5 essay). | Server does not reject a payload if admin requested 5 MCQ + 5 essay but 4+6 were generated. |
| **D.2 MCQ Validation (>=2 options, 1 valid answer)** | NO | NO | `quizService.js:45-64` only checks `ALLOWED_QUESTION_TYPES.includes(el.type)`. It does NOT verify that `choices` array has `>= 2` options, nor that `correctValue` matches one of the choices. | Malformed MCQs (e.g. 1 option or mismatched answer key) are accepted into the database. |
| **D.3 Essay Rubric / Model Answer Validation** | PARTIALLY | NO | `quizService.js:111-125` checks `modelAnswer` is present. However, `rubric` is optional even when `ai.enabled === true`. | AI grading requires rubric/model criteria, but server allows `ai.enabled === true` with no rubric. |
| **D.4 Non-empty Text & Arabic Storage** | YES | YES | Prisma Postgres stores UTF-8 Arabic text intact. Zod validates string presence. | None. |
| **E. Gemini Tool Schema Compatibility** | YES | YES | `src/services/agent/tools/index.js:185-225` (`stripUnsupportedSchemaKeys`) sanitizes schemas for Gemini. All 55 tools approximate ~4,496 tokens. | None for existing tools, but new `create_quiz` tool must avoid unsupported JSON schema keywords. |
| **F. Agent Audit Logging** | YES | YES | `src/services/agent/tools/_kit.js:414-418` automatically calls `audit.record` for all `actionTool` executions. | None. |

---

## What Will Be Changed (Phase 2 Plan)

1. **Course & Video Lookup Tools**:
   - Create or update `course_search` / `course_videos` tools:
     - Normalizes Arabic search queries (removes tashkeel, normalizes أ/إ/آ → ا, ة → ه, ى → ي).
     - Returns courses matching query with disambiguation metadata (`ambiguous: true` if multiple matches).
     - Returns videos of a course ordered by `position ASC`, then `id ASC`, including title, slug, and whether a quiz already exists.
2. **Dedicated `create_quiz` Action Tool**:
   - Accepts high-level typed questions:
     ```typescript
     {
       videoSlug: string,
       title: string,
       passingScore?: number, // default 50
       timeLimitSec?: number,
       maxAttempts?: number,  // default 3
       expectedMcqCount?: number,   // e.g. 5
       expectedEssayCount?: number, // e.g. 5
       questions: Array<{
         type: 'mcq' | 'essay',
         text: string,
         points: number,
         options?: string[],      // MCQ: >= 2 choices
         correctOption?: string,  // MCQ: must match one of options
         modelAnswer?: string,    // Essay: required
         rubric?: string,         // Essay: required if aiGrading is true
         aiGrading?: boolean      // Essay: default true
       }>
     }
     ```
   - Automatically builds valid SurveyJS JSON (`pages[0].elements`) and server `answerKey` with `{ ai: { enabled: true } }`.
3. **Server-Side Validation Service**:
   - Enforces in service layer:
     - Exact requested counts (e.g. 5 MCQ, 5 essay).
     - Every MCQ has >= 2 choices and `correctOption` is in `options`.
     - Every essay has non-empty `modelAnswer` and non-empty `rubric` when `aiGrading` is true.
     - Positive points per question.
4. **Resolution of Stop Condition (Pending User Decision)**:
   - Fix AI grading pipeline so it does NOT auto-publish scores to students:
     - When AI grading finishes, keep `QuizAttempt.status = STATUS.GRADING`.
     - Record proposed AI score, confidence, feedback, and `criteriaBreakdown` in `essayFeedback[qName].aiVerdict`.
     - Only an admin/teacher action (`POST /admin/attempts/:id/grade`) finalizes the attempt to `STATUS.GRADED`.
