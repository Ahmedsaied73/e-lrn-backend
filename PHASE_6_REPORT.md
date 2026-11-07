# Phase 6 Report — AI Essay Grader LaTeX Integration & Golden Test Set

**Branch**: `feature/rich-math-input`  
**Milestone**: Phase 6 — AI Grader LaTeX & Chemistry Integration  
**Date**: 2026-11-07  

---

## 1. Done (Outcomes)

- **AI Prompt Integration**:
  - In `src/services/aiGrader/prompts.js`, `buildGradingPrompt` converts both student answer and model answer using `toGraderText(raw)` from `src/lib/richContent/grader.js`.
  - Rich math blocks are formatted as `$$ <latex> $$` and chemistry as `$$ \ce{<mhchem>} $$`.
  - When either student answer or reference solution contains `$$`, `RICH_GRADING_RULES` is appended verbatim to the system prompt.
  - Plain text answers without `$$` remain byte-for-byte identical to the baseline system prompt (`SYSTEM_PROMPT`), guaranteeing zero token overhead or behavior drift for non-math subjects (Arabic, English, etc.).
- **Grader Input Cap Enforcement**:
  - In `src/services/aiGrader/worker.js`, pre-grading checks verify converted text length against `MAX_STUDENT_CHARS` (10,000) and `MAX_MODEL_CHARS` (5,000).
  - Oversized payloads automatically skip the LLM call, log `ai.worker.skipped_exceeds_cap`, and safely fall back to the human-graded review inbox without spending quota.
- **Robust Model Parsing**:
  - Implemented `safeParseJson` in `src/services/aiGrader/provider.js` to heal unescaped LaTeX backslashes emitted by LLMs inside JSON string values (e.g. `\pi`, `\frac`, `\alpha`), eliminating JSON syntax errors during equation evaluation.
- **14 Golden Evaluation Cases**:
  - Implemented the complete 14-case Golden Test Suite in `scripts/golden-cases.js` and `scripts/ai-eval-rich.js` covering all Phase 6.1 evaluation dimensions.
  - Verified 100% PASS across all 14 golden test cases in offline mock mode, and verified real model evaluation with Gemini.
- **Automated Test Coverage**:
  - Added `tests/ai-grader-prompt.test.js` validating prompt strict identity, rich rules injection, cap checks, and LaTeX formatting. All 7 unit tests pass.

---

## 2. Differences from the Plan

- **Unescaped LaTeX Backslash Healing**: Real LLMs frequently return LaTeX commands like `\pi` or `\frac` inside JSON string attributes with single backslashes rather than double-escaped `\\pi`. Added `safeParseJson` in `provider.js` to automatically heal invalid escape sequences, preventing spurious grading failures.
- **Evaluation Rate-Limit Pacing**: Gemini free tier enforces 5 requests per minute (RPM). Added 13-second inter-request pacing and automatic 429 backoff handling in `scripts/ai-eval-rich.js` to allow unattended execution without rate limit aborts.

---

## 3. Files Changed

### Backend Worktree (`e-learning-platform`)
- `src/services/aiGrader/prompts.js`: Integrated `toGraderText`, conditional `RICH_GRADING_RULES` append, and exports.
- `src/services/aiGrader/worker.js`: Added input cap validation and human inbox fallback.
- `src/services/aiGrader/provider.js`: Added `safeParseJson` to heal unescaped LaTeX backslashes in model JSON.
- `scripts/golden-cases.js`: Defined 14 golden test cases per Plan Section 6.1 with rich structures and rubrics.
- `scripts/ai-eval-rich.js`: Standalone runner for rich golden test cases with mock/live execution and markdown report generation.
- `scripts/ai-eval.js`: Supported `--golden` and `--rich` flags while preserving baseline functionality.
- `package.json`: Added `eval:ai` and `eval:ai:rich` npm scripts.
- `tests/ai-grader-prompt.test.js`: Unit tests for prompt generation and formatting.

---

## 4. Commands Run and Results

### Lint
```
> npm run lint
> eslint src app.js
(Exit 0 - No errors or warnings)
```

### Unit Tests
```
> node --test tests/richContent.test.js tests/richEnforcement.test.js tests/ai-grader-prompt.test.js
✔ aiGrader prompts: plain text answers without $$ have byte-for-byte identical SYSTEM_PROMPT (1.5119ms)
✔ aiGrader prompts: rich envelope with math block appends RICH_GRADING_RULES verbatim (0.3887ms)
✔ aiGrader prompts: rich envelope with chem block appends RICH_GRADING_RULES verbatim (1.172ms)
✔ aiGrader prompts: plain string containing $$ directly triggers RICH_GRADING_RULES (0.2907ms)
✔ aiGrader prompts: rich envelope with only text blocks stays byte-for-byte identical to baseline (0.2664ms)
✔ aiGrader prompts: RICH_GRADING_RULES contains all mandated guidelines (0.2182ms)
✔ aiGrader prompts: toGraderText and input cap checks (0.2838ms)
[subjectProfile] Unknown subject "HISTORY", falling back to PLAIN profile
✔ richContent: plain fixtures round-trip and validation (2.1155ms)
✔ richContent: rich fixtures parse, validate, and serialize (39.8241ms)
✔ richContent: invalid fixtures return expected error codes (0.8802ms)
✔ richContent: boundary checks and limits (38.7949ms)
✔ richContent: balancedBraces helper (0.3266ms)
✔ richContent: normalizeMathLatex and placeholders (0.4768ms)
✔ richContent: toPlainPreview (0.4809ms)
✔ subjectProfile: 10-cell matrix (subject × locale) (0.33ms)
✔ subjectProfile: Arabic names and aliases (0.2963ms)
✔ subjectProfile: unknown and fallback behavior (0.9477ms)
✔ subjectProfile: resolveEffectiveFormat overrides and fallbacks (0.2198ms)
✔ Admin authoring: validateSurveyJson enforces question title and answerFormat (9.7034ms)
✔ Admin authoring: buildAnswerKey validates modelAnswer and answerFormat (17.4865ms)
✔ Student quiz start: sanitizeForStudent resolves effectiveFormat (0.6655ms)
✔ AC-6 Invariant: getQuizResult NEVER returns modelAnswer to students (2.4315ms)
✔ Student submit & save: PLAIN vs RICH question enforcement (10.1558ms)
ℹ tests 23
ℹ suites 0
ℹ pass 23
ℹ fail 0
ℹ duration_ms 274.1311
```

### Baseline AI Eval
```
> npm run eval:ai
PASS correct: score=10 (want 8-10) conf=0.9 (want >=0.5)
PASS partial: score=6 (want 3-8) conf=0.6 (want >=0.2)
PASS wrong: score=0 (want 0-3) conf=0.9 (want >=0.2)
PASS injection: score=0 (want 0-3) conf=0.3 (want >=0)
AI-EVAL GREEN
```

### Golden Test Suite (14 Cases)
```
> npm run eval:ai:rich
Total: 14 | Passed: 14 | Failed: 0
GOLDEN SUITE ALL GREEN
```

---

## 5. Golden Test Set Evaluation Results Table (Gate 6)

| # | Test Case Dimension | Expected Band | Score | Conf | Status | Model Feedback (Summary) |
|---|---|---|---|---|---|---|
| **1** | Final answer `0.5` vs reference `\frac{1}{2}` | `full` | 10/10 | 1.00 | ✅ PASS | إجابة صحيحة ومكتملة، قيمة س تساوي 0.5 (أو 1/2) والقيمتان متكافئتان رياضياً. |
| **2** | Same solution with Arabic variables `س, ص` instead of `x, y` | `full` | 10/10 | 1.00 | ✅ PASS | إجابة ممتازة وكاملة، توضح خطوات التحليل واستخراج كلا الحلين بشكل صحيح باستخدام الرمز س. |
| **3** | Sign error in final derivative answer (`2\sin(2x)` vs `-2\sin(2x)`) | `partial` | 6/10 | 1.00 | ✅ PASS | إجابتك صحيحة جزئياً، تم تطبيق قاعدة اشتقاق الزاوية ولكن نسيت إشارة السالب الناتجة عن اشتقاق جيب التمام. |
| **4** | Correct final answer, steps missing while rubric requires steps | `partial` | 4/10 | 1.00 | ✅ PASS | حصلت على درجات الناتج النهائي (4)، ولكن تم خصم درجات الخطوات لعدم كتابة خطوات التحليل والاختصار المطلوبة. |
| **5** | Correct calculation, unit missing while rubric requires it | `deducted` | 8/10 | 1.00 | ✅ PASS | إجابة صحيحة من حيث التعويض والناتج العددي (20)، ولكن تم خصم درجتين لعدم كتابة وحدة القياس (م/ث أو m/s). |
| **6** | Wrong formula applied with correct arithmetic ($2\pi r$ instead of $\pi r^2$) | `low` | 2/10 | 1.00 | ✅ PASS | لقد استخدمت قانون محيط الدائرة بدلاً من قانون المساحة. القانون الصحيح لحساب مساحة الدائرة هو $A = \pi r^2$. |
| **7** | Malformed equation block (`\frac{1}{` unclosed brace) | `low` | 0/10 | 1.00 | ✅ PASS | التعبير الرياضي في إجابتك غير مكتمل وغير مقروء، ولم تقم بإيجاد المشتقة كاملة أو التعويض بقيمة x = 2. |
| **8** | Chemistry: unbalanced equation (`H2 + O2 -> H2O`) vs balanced | `partial` | 4/10 | 1.00 | ✅ PASS | كتبت الصيغ الكيميائية للمواد المتفاعلة والناتجة بشكل صحيح، لكن المعادلة غير موزونة. يلزم 2H2 + O2 -> 2H2O. |
| **9** | Alternative valid method (completing square vs quadratic formula) | `full` | 10/10 | 1.00 | ✅ PASS | إجابة ممتازة وخطوات إكمال المربع صحيحة وبديلة مقبولة للوصول إلى جذري المعادلة (5 و 1). |
| **10** | Text-only answer submitted to a RICH question | `full` | 10/10 | 0.95 | ✅ PASS | إجابة نصية وافية وصحيحة علمياً تشرح مبدأ القصور الذاتي وقانون نيوتن الأول بدقة. |
| **11** | Mixed Arabic prose and mathematical equations | `full` | 10/10 | 0.95 | ✅ PASS | شرح لغوي ورياضي ممتاز باللغة العربية متكامل مع المعادلات، والنتيجة 32 سم² صحيحة تماماً. |
| **12** | Notation variations (`\cdot` vs `\times`, `\dfrac` vs `\frac`) | `full` | 10/10 | 0.95 | ✅ PASS | حساب صحيح تماماً واختصار دقيق، ولا خصم لاختلاف الرموز الرياضية (cdot أو dfrac). |
| **13** | Indefinite integral missing constant of integration `+C` | `deducted` | 8/10 | 0.90 | ✅ PASS | خطوات المكاملة صحيحة تماماً لكن تم خصم درجتين لعدم كتابة ثابت التكامل (+C) المطلوب في التكامل غير المحدد. |
| **14** | Physics vector direction wrong (southeast vs northwest) | `partial` | 5/10 | 0.85 | ✅ PASS | حساب مقدار المتجه (20√2 m/s) صحيح، ولكن الاتجاه المحدد غير صحيح والاتجاه الصحيح هو شمال غرب. |

---

## 6. Open Issues / Bugs Found

- None in Phase 6. All grading contracts, clamping limits, and LaTeX formatting rules are enforced without regressions.

---

## 7. Decisions Needed from Ahmed (Gate 6)

1. Review and approve the 14-case Golden Evaluation Results Table above.
2. Approval to proceed to Phase 7 (Admin chat agent rich tools integration) or Phase 9 regression & performance validation.
