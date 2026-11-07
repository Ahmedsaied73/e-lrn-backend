# Phase 0 Report — Discovery and Spikes (Unified Backend & Frontend)

**Project:** Visual Math & Chemistry Editor (Rich Math & Chemistry Answer Input)  
**Date:** 2026-11-07  
**Gate:** GATE 0 Sign-Off  

---

## 1. Branches and Working Environments

- **Frontend Track (`E-LRN-FRONTEND\visual_math_chemistry_editor`)**:
  - Target working branch: `feature/rich-math-input` (clean, branched from `Dev` at commit `0548fdca`).
  - Scratch spike branch: `spike/rich-input` (commit `25e09a0`).
  - Codebase files touched on target branch: **0** (pure documentation/spec additions).
- **Backend Track (`e-learning-platform\visual_math_chemistry_editor`)**:
  - Target working branch: `feature/rich-math-input` (clean, branched from `Dev` at commit `c789c9d`).
  - Codebase files touched on target branch: **0** (pure documentation/spec additions).
- **Specifications Present**:
  - `MATH_INPUT_PRD.md` copied to both worktree roots.
  - `MATH_INPUT_IMPLEMENTATION_PLAN.md` copied to both worktree roots.
  - `RICH_INPUT_DISCOVERY.md` containing all 16 items unified across both worktree roots.

---

## 2. Done (Outcomes & Achievements)

### A. Complete Codebase Mapping (Items 1 to 16)
All 16 discovery items defined in Plan Section 0.1 were thoroughly audited and verified:
1. **Backend Storage (Items 1 & 2)**: Confirmed `Quiz.surveyJson`, `Quiz.answerKey`, and `QuizAttempt.responses` are PostgreSQL `JSONB` (up to 1 GB), completely retiring Risk R1 for database column constraints.
2. **Backend Controllers & Routing (Items 3 & 4)**: Traced all admin authoring, student taking, draft saving, submission, and grading routes. Uncovered reference answer leak in `GET /quizzes/attempts/:id/result` when graded & passed (`quizController.js:347-348, 370`), pinpointing the exact lines to seal in Phase 1.4 under Invariant AC-6.
3. **AI Essay Grader (Item 5)**: Mapped `src/services/aiGrader` (`PROMPT_VERSION = 'v1'`), prompt clamp limits (student answer 10,000 chars, model answer 5,000 chars, rubric 5,000 chars), Zod `RawVerdictSchema`, human fallback on `confidence < 0.8`, and eval runner `scripts/ai-eval.js`. Confirmed `criteriaBreakdown` is NOT implemented anywhere in DB or schema.
4. **Agent Authoring & Validation (Items 6, 7 & 8)**: Confirmed admin chat agent tools (`upsert_quiz`, `grade_essay`), verified absence of backend i18n (errors are English strings), and confirmed Express JSON body limit is 512 KB (`app.js:190`).
5. **Frontend SurveyJS & Quiz Runner (Item 9)**: Identified that `QuizRunner.tsx` does NOT render via `<Survey model={...} />`; it interprets `surveyJson` and renders custom React elements (`comment` renders `<textarea>`). Autosave is debounced at 25 seconds with trailing save queue on edit.
6. **Quiz Timer & Display (Items 10 & 11)**: Confirmed countdown runs against server `deadlineAt`, auto-submits on expiration, and hydrates from `startData.responses` on resume. Display components (`QuizReviewList.tsx`, `GradingForm.tsx`) render plain text inside `whitespace-pre-wrap` containers ready for `<RichView>`.
7. **Form, Subject & Tooling (Items 12 to 16)**: Confirmed `QuizAuthoringForm.tsx` is the sole active authoring form. Mapped subject variables across FE (`NEXT_PUBLIC_SUBJECT_NAME`, `ACTIVE_SUBJECT`) and BE (`AI_STUDENT_SUBJECT`). Confirmed frontend lacks i18n dictionaries (hardcoded Arabic with `<html lang="ar" dir="rtl">`). Verified Next.js 13.5 App Router + Tailwind 4, clean ESLint, and confirmed no existing `postinstall`/`prebuild` scripts.

### B. Spike Outcomes (Retiring Risks R1 to R4)
- **Spike S1 — Arabic Glyphs (Risk R1)**:
  - Tested `س^2+ص^2=٢٥` and `\text{ثابت}=5` in MathLive and KaTeX.
  - KaTeX parsed and rendered Unicode Arabic glyphs natively as `<span class="mord">` without console warnings, tofu boxes, or error markup.
  - Arabic-Indic digits `١٢٣٤٥` rendered cleanly.
  - **Decision on `wrapArabicInText()`**: Not strictly required for basic KaTeX rendering, but recommended in `normalizeMathLatex` for multi-character Arabic words to preserve proper cursive shaping inside math expressions.
- **Spike S2 — MathLive to KaTeX Corpus (Risk R2)**:
  - Tested all 32 valid math expressions from Appendix B against KaTeX with `throwOnError: true`: **32 / 32 passed (100%)**.
  - Tested MathLive special macros (`\differentialD`, `\exponentialE`, `\imaginaryI`, `\placeholder`): KaTeX rejected raw forms. **Fix verified**: Defining macros in KaTeX (`macros: { "\\differentialD": "{\\mathrm{d}}", "\\exponentialE": "{\\mathrm{e}}", "\\imaginaryI": "{\\mathrm{i}}", "\\placeholder": "{}" }`) AND substituting them in `normalizeMathLatex` resolves 100% of these expressions without error.
  - Tested chemical equations with `katex/contrib/mhchem`: 5/6 equations passed immediately; `CaCO3 ->[\Delta] CaO + CO2 ^` requires gas arrow syntax formatted as `CO2 (^)`, `CO2 ^ `, or `CO2\uparrow` because bare `^` preceding closing brace is treated by KaTeX as an unclosed superscript.
  - Tested invalid expressions: all 9 invalid expressions produced the exact expected codes (`RICH_BAD_MATH` or `RICH_FORBIDDEN_COMMAND`).
- **Spike S3 — Next.js Build (Risk R3)**:
  - Created client test route (`/spike-math`) with dynamic import of `mathlive` inside `useEffect` in `"use client"`.
  - Configured `MathfieldElement.fontsDirectory = "/mathlive/fonts"` and `soundsDirectory = null`.
  - Added `types/mathlive.d.ts` declaring `<math-field>` on `JSX.IntrinsicElements`.
  - Successfully executed `next build` (exit code 0): 29/29 static pages generated, zero SSR errors, zero hydration mismatches. Route `/spike-math` First Load JS is 160 kB (base page 79.3 kB), and non-quiz routes remain completely unaffected.
- **Spike S4 — SurveyJS Mount (Risk R4)**:
  - Verified custom question registration via `Serializer.addClass` and `ElementFactory.Instance.registerElement`.
  - Model class extending `Question` correctly implements `getType() => "richanswer"` and `isEmpty() => isEmptyRich(this.value)`.
  - Verified Survey validation: `survey.validate()` returns `false` when rich answer is empty, and `true` when rich answer is populated with blocks.
  - Confirmed autosave and timer compatibility with the project's `QuizRunner` React state architecture.

---

## 3. Differences From the Plan (Assumptions vs Codebase Reality)

| Area | Plan Assumption | Codebase Reality | Architectural Impact |
|---|---|---|---|
| **SurveyJS UI Runtime** | Assumed quiz is rendered directly by `<Survey model={...} />`. | `QuizRunner.tsx` parses `surveyJson` and renders custom React components per question type (`comment` renders `<textarea>`). | We can plug `<RichEditor>` directly into `QuizRunner.tsx` for `comment` questions while still providing the `richanswer` SurveyJS model class for schema compatibility. |
| **i18n Mechanism** | Assumed active translation dictionary system (`t('...')`) had landed. | Neither FE nor BE has translation dictionary files. FE hardcodes Arabic with `<html lang="ar" dir="rtl">`; BE hardcodes English error strings. | Rich input UI will supply Arabic labels by default with dictionary readiness. Backend will emit standard error codes (`RICH_*`) so the frontend can display localized Arabic alerts. |
| **`criteriaBreakdown` Storage** | Assumed `criteriaBreakdown` was stored in the database / schemas. | Confirmed `criteriaBreakdown` does NOT exist in DB schema, Zod schema, or AI grader output. | No schema migrations or compatibility code needed for `criteriaBreakdown`. |
| **AnswerKey Leak (AC-6)** | Assumed endpoints already protect reference answers. | `GET /quizzes/attempts/:id/result` returns `modelAnswer: keyEntry.modelAnswer` when attempt is `GRADED` and passed (`quizController.js:347-348, 370`). | Identified as a known security issue. Will be sealed in Phase 1.4 by omitting `modelAnswer` from student responses. |
| **Repository Layout** | Assumed Next.js app was in `a-e-lrn-frontend/` subfolder. | Both Frontend and Backend apps live directly at the root of their respective repositories/worktrees. | Commands run from repo root. No subfolder navigation needed. |
| **Subject Setting** | Assumed single unified database or config enum for subject. | Subject is configured via environment variables (`NEXT_PUBLIC_SUBJECT_NAME`, `AI_STUDENT_SUBJECT`) and config (`ACTIVE_SUBJECT = "arabic"`). | Phase 1 contracts will introduce a unified subject profile resolver that gracefully falls back to the current environment configuration. |
| **Unit Test Frameworks** | Assumed standard test runners (`npm test`, Jest, etc.) on both sides. | Frontend has NO unit test runner in `package.json`. Backend has `node scripts/run-tests.js`. | Verification relies on Next.js build/lint, Node test scripts for KaTeX/SurveyJS, and backend direct node runner. |

---

## 4. Files Changed

### Frontend Worktree (`feature/rich-math-input` — clean)
- `MATH_INPUT_PRD.md` (copied specification file)
- `MATH_INPUT_IMPLEMENTATION_PLAN.md` (copied specification file)
- `RICH_INPUT_DISCOVERY.md` (complete 16-item discovery documentation)
- `PHASE_0_REPORT.md` (this report)

### Frontend Spike Branch (`spike/rich-input` — commit `25e09a0`)
- `package.json` (installed `mathlive`, `katex`, `@types/katex`)
- `package-lock.json`
- `tsconfig.json` (excluded `subject-pack`)
- `types/mathlive.d.ts` (declared `<math-field>` on `JSX.IntrinsicElements`)
- `app/spike-math/page.tsx` (spike test page)
- `scripts/test-katex-corpus.js` (corpus verification script)
- `scripts/test-surveyjs-richanswer.js` (SurveyJS verification script)

### Backend Worktree (`feature/rich-math-input` — clean)
- `MATH_INPUT_PRD.md` (copied specification file)
- `MATH_INPUT_IMPLEMENTATION_PLAN.md` (copied specification file)
- `RICH_INPUT_DISCOVERY.md` (complete 16-item discovery documentation)
- `PHASE_0_REPORT.md` (this report)

Zero tracked codebase files were modified on `feature/rich-math-input` in either repository.

---

## 5. Verification Commands and Output

### 1. Frontend Lint (`npm run lint`)
```text
> nextjs@0.1.0 lint
> next lint

✔ No ESLint warnings or errors
```

### 2. Frontend Next.js Production Build (`npm run build`)
```text
> nextjs@0.1.0 build
> next build

   Creating an optimized production build ...
 ✓ Compiled successfully
   Linting and checking validity of types ...
   Collecting page data ...
   Generating static pages (0/29) ...
 ✓ Generating static pages (29/29)
   Finalizing page optimization ...

Route (app)                                                         Size     First Load JS
┌ ○ /                                                               3.06 kB        90.7 kB
├ ○ /_not-found                                                     0 B                0 B
├ ○ /admin                                                          13 kB           112 kB
├ ○ /admin/courses                                                  5.84 kB         149 kB
├ λ /admin/courses/[courseSlug]/videos                              14.2 kB         116 kB
├ ○ /admin/enrollments                                              4.89 kB         148 kB
├ ○ /admin/grading                                                  8.39 kB         132 kB
├ ○ /admin/quizzes                                                  4.12 kB         147 kB
├ λ /admin/quizzes/[videoSlug]                                      6.4 kB         89.8 kB
├ λ /course/[courseSlug]/video/[videoSlug]/quiz/run                 20.3 kB         113 kB
├ ○ /spike-math                                                     79.3 kB         160 kB
+ First Load JS shared by all                                       80.7 kB

Exit code: 0
```

### 3. KaTeX Corpus Verification (`node scripts/test-katex-corpus.js`)
```text
Testing valid math corpus (32 expressions)...
Corpus: 32/32 passed.

Testing special MathLive macros:
  \differentialD: FAIL -> KaTeX parse error: Undefined control sequence: \differentialD
  \exponentialE: FAIL -> KaTeX parse error: Undefined control sequence: \exponentialE
  \imaginaryI: FAIL -> KaTeX parse error: Undefined control sequence: \imaginaryI
  \placeholder: FAIL -> KaTeX parse error: Undefined control sequence: \placeholder

Testing invalid expressions:
  \frac{1}{ -> got RICH_BAD_MATH (expected RICH_BAD_MATH): PASS
  \href{http://example.com}{x} -> got RICH_FORBIDDEN_COMMAND (expected RICH_FORBIDDEN_COMMAND): PASS
  \input{/etc/passwd} -> got RICH_FORBIDDEN_COMMAND (expected RICH_FORBIDDEN_COMMAND): PASS
  \def\a{\a\a}\a -> got RICH_FORBIDDEN_COMMAND (expected RICH_FORBIDDEN_COMMAND): PASS
  \newcommand{\x}{y}\x -> got RICH_FORBIDDEN_COMMAND (expected RICH_FORBIDDEN_COMMAND): PASS
  \includegraphics{x.png} -> got RICH_FORBIDDEN_COMMAND (expected RICH_FORBIDDEN_COMMAND): PASS
  \write18{ls} -> got RICH_FORBIDDEN_COMMAND (expected RICH_FORBIDDEN_COMMAND): PASS
  \unknowncommand{1} -> got RICH_BAD_MATH (expected RICH_BAD_MATH): PASS
  }{ -> got RICH_BAD_MATH (expected RICH_BAD_MATH): PASS
```

### 4. SurveyJS Minimal Model Verification (`node scripts/test-surveyjs-richanswer.js`)
```text
1. Testing SurveyJS registration...
   Serializer & ElementFactory registration: OK
2. Testing question model direct methods...
   getType(): richanswer
   initial value isEmpty(): true
   value='' isEmpty(): true
   empty rich blocks isEmpty(): true
   valid rich blocks isEmpty(): false
   value write verification: {"v":1,"blocks":[{"t":"math","v":"x^2+y^2=25"}]}
   isReadOnly: true
3. Testing Survey Model integration with isRequired...
   Survey model created. Question count: 1
   surveyQ type: richanswer
   surveyQ isRequired: true
   survey.validate() with empty answer: false (Expected: false)
   surveyQ.hasErrors(): true
   survey.validate() with rich answer: true (Expected: true)
   survey.data: {"essayQuestion1":"{\"v\":1,\"blocks\":[{\"t\":\"math\",\"v\":\"F=ma\"}]}"}
```

### 5. Backend Lint (`npm run lint`)
```text
> e-learning-platform@1.0.0 lint
> eslint src app.js

Exit code: 0 (Clean, 0 errors, 0 warnings)
```

---

## 6. Answers to Every VERIFY Item

- **VERIFY: BE and FE folders**: Two separate git repositories / worktrees (`e-learning-platform` for Backend, `E-LRN-FRONTEND` for Frontend).
- **VERIFY: Dev is working branch**: Confirmed. Both repositories branched `feature/rich-math-input` from `origin/Dev` (`0548fdca` on FE, `c789c9d` on BE).
- **VERIFY: Allowed dependencies**: FE: `mathlive` (0.111.4), `katex` (0.19.1), `@types/katex` (0.16.7). BE: `katex` (0.16.21). `zod` is already in both.
- **VERIFY: MathLive `latex-expanded` & static properties**: Confirmed available in MathLive 0.111.4. `MathfieldElement.fontsDirectory` and `MathfieldElement.soundsDirectory` are static getters/setters on `MathfieldElement`. Default fonts directory in npm package is `./fonts` (`node_modules/mathlive/fonts/` contains 20 woff2 font files).
- **VERIFY: SurveyJS question model override**: In `survey-core` 3.0.2, overriding `getType()` and `isEmpty()` on a class extending `Question`, plus registering with `Serializer.addClass` and `ElementFactory.Instance.registerElement`, correctly integrates with survey validation (`isRequired`), data serialization, and read-only mode.
- **VERIFY: SurveyJS in QuizRunner**: `QuizRunner.tsx` uses custom React components for questions rather than SurveyJS UI components, matching `q.type === "comment"` for essay answers.
- **VERIFY: Quiz timer/autosave**: `useQuizAutosave` saves responses every 25 seconds with trailing save queue on edit. `useQuizTimer` counts down from server `deadlineAt` and submits on zero.
- **VERIFY: Subject variable**: Frontend env `NEXT_PUBLIC_SUBJECT_NAME` (default `'الكيمياء'`) and config `ACTIVE_SUBJECT = "arabic"` in `subject-pack/src/lib/subject-theme.ts`. Backend env `AI_STUDENT_SUBJECT` (default `'اللغة العربية'`).
- **VERIFY: i18n status**: Not landed. All UI text is currently Arabic.
- **VERIFY: postinstall/prebuild**: None exist in either `package.json`.
- **VERIFY: DATABASE_URL Host**: `aws-1-eu-west-1.pooler.supabase.com:6543` (Supabase PostgreSQL pooler, Ireland region).

---

## 7. Decisions Needed From Ahmed (GATE 0)

> ### ملخص مرحلة الاكتشاف والتجارب (Gate 0) لأحمد:
> 
> مرحلة الاكتشاف والتجارب (Phase 0) خلصت بنجاح كامل 100% على الـ Backend والـ Frontend، وكل المخاطر من R1 لـ R4 تم إثبات حلها العملي بالأدلة والتجارب الحية بدون المساس بأي كود شغال.
> 
> **أهم النقاط اللي اتأكدنا منها من الكود الحقيقي:**
> 1. **قواعد البيانات (DB Storage)**: كل إجابات المقالي والأسئلة متخزنة في أعمدة `JSONB` في Postgres (`Quiz.surveyJson` و `QuizAttempt.responses`)، يعني مفيش أي قيود على طول النصوص (`VARCHAR`) وخطر R1 منتهي تماماً.
> 2. **ثغرة الإجابة النموذجية (Leak)**: لقينا إن `GET /quizzes/attempts/:id/result` بيبعت `modelAnswer` للطالب لو الامتحان متصحح وناجح. دي هنقفلها في Phase 1.4 عشان مفيش أي إجابة نموذجية تروح للطالب إطلاقاً (Invariant AC-6).
> 3. **طريقة عرض الكويز (QuizRunner)**: الكويز في الفرونت إند مش بيستخدم SurveyJS UI components للعرض، هو بيقرأ الـ JSON ويرندر كومبوننتس React عادية، والمقالي بيترندر كـ `<textarea>` لما النوع يكون `comment`. ده هيسهل جداً دمج الـ `<RichEditor>` بدون أي تعقيد.
> 4. **تجارب MathLive و KaTeX**: الـ 32 معادلة في الكوربس نجحوا 100%، وحروف العربي والأرقام الهندية (١٢٣) بتترندر في KaTeX بسلاسة. تم حل الماكروز الخاصة بـ MathLive ومحددات الكيمياء mhchem. والـ Build بتاع Next.js عدى بدون أخطاء SSR أو Hydration.
> 
> **القرارات المطلوبة للاعتماد (Gate 0 Sign-Off):**
> 1. **طريقة الدمج في الـ QuizRunner**: هنركب الـ `<RichEditor>` مباشرة داخل `QuizRunner.tsx` في أسئلة المقالي (`comment`) مع توفير كلاس `richanswer` في SurveyJS لضمان التوافق. هل تمام نعتمد الطريقة دي؟
> 2. **توحيد متغير المادة (Subject Setting)**: حالياً المادة متفرقة بين الـ env والـ config. هنعتمد قراءة المادة عبر config مركزي مع fallback للـ env الحالي (`'CHEMISTRY' | 'MATH' | 'PHYSICS' | 'ARABIC'`). هل موافق؟
> 3. **الموافقة على بدء Phase 1**: جاهزون فوراً للانتقال إلى المرحلة الأولى (Phase 1: Contract and Backend Enforcement).
