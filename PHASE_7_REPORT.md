# Phase 7 Report — Admin Chat Agent Rich Tools & Instructions

**Branch**: `feature/rich-math-input`  
**Milestone**: Phase 7 — Admin Chat Agent Rich Authoring & Grading Tools  
**Date**: 2026-11-07  

---

## 1. Done (Outcomes)

- **Admin Agent Tool Schema Extensions**:
  - In `src/services/agent/tools/actions.js`, updated `upsert_quiz` tool schema and handler:
    - Accepts question titles and reference answers as either a plain string or an array of rich blocks `[{ t: 'text'|'math'|'chem', v: string }]`.
    - Added support for friendly `questions` array input where `title`, `modelAnswer`, and `referenceAnswer` accept rich blocks or plain strings.
    - Added top-level `referenceAnswers` map `{ [qName]: string | blocks }` for direct reference solution binding.
  - In `src/services/agent/tools/actions.js`, updated `grade_essay` tool schema and handler:
    - Updated `essayFeedback` to accept either plain strings or arrays of blocks `[{ t: 'text'|'math'|'chem', v: string }]`.
    - Added `referenceAnswers` and `questionText` maps accepting plain strings or block arrays.
- **Server-Side Serialization and KaTeX Validation**:
  - Implemented `processRichInput(val, fieldName)` in `actions.js`:
    - Automatically serializes rich block arrays into envelopes (`{"v":1,"blocks":[...]}`) or plain text (for text-only blocks) via `serializeRich`.
    - Performs strict validation on all rich inputs via `validateRich`, enforcing character limits, KaTeX math parsing (`katex.renderToString`), mhchem chemistry syntax, and rejecting dangerous/forbidden LaTeX commands (`\input`, `\def`, `\let`, `\catcode`, etc.).
    - Model never has to construct the JSON envelope syntax manually.
- **Agent System Prompt Guidelines**:
  - In `src/services/agent/graph.js` (and `src/services/agent/prompt.js`), appended 3 lines instructing the agent:
    1. Use `math` blocks with LaTeX for equations (`[{ t: "math", v: "..." }]`).
    2. Use `chem` blocks with mhchem syntax for chemical equations (`[{ t: "chem", v: "..." }]`).
    3. Never mix prose/language explanations into math or chem blocks; put prose in distinct `text` blocks and formulas strictly in `math`/`chem`.
- **Gemini Transport & Model Safety**:
  - Verified that all tool schemas convert safely via `stripUnsupportedSchemaKeys` and `toLangChainTools` without leaking unsupported keywords to Gemini, and without losing argument bounds.
- **Automated Test Coverage**:
  - Implemented `tests/agent-rich-tools.test.js` covering:
    - `upsert_quiz` with plain text vs rich block arrays in question title and modelAnswer.
    - `upsert_quiz` with chemistry blocks (`mhchem`) in questions and reference answers.
    - `upsert_quiz` with friendly `questions` array.
    - `upsert_quiz` rejection of malformed LaTeX syntax (`RICH_BAD_MATH`) and forbidden commands (`RICH_FORBIDDEN_COMMAND`).
    - `grade_essay` with plain text feedback and rich block feedback.
    - `grade_essay` with `referenceAnswers` and `questionText` blocks.
    - `grade_essay` rejection of malformed LaTeX math in feedback.
    - Agent system prompt instruction inclusion.
    - Gemini JSON Schema stripping sanity and argument retention.
  - All 12 tests pass cleanly.

---

## 2. Differences from the Plan

- **None**: Followed the plan and dispatch directives precisely with /ponytail lean senior dev discipline. No extraneous packages or abstractions added.

---

## 3. Files Changed

### Backend Worktree (`e-learning-platform`)
- `src/services/agent/tools/actions.js`:
  - Imported `serializeRich`, `validateRich`, `looksRich` from `src/lib/richContent`.
  - Added `richBlockSchema`, `richTextOrBlocksSchema`, and `processRichInput`.
  - Updated `grade_essay` schema and handler for rich feedback and reference answers.
  - Updated `upsert_quiz` schema and handler for rich titles, model answers, and question arrays.
- `src/services/agent/graph.js`:
  - Appended the 3 math/chemistry instruction lines to `buildSystemPrompt`.
- `src/services/agent/prompt.js`:
  - Created prompt module re-exporting `buildSystemPrompt` and `RICH_AGENT_INSTRUCTIONS`.
- `tests/agent-rich-tools.test.js`:
  - Comprehensive unit test suite for agent rich tools and prompt.

---

## 4. Commands Run and Results

### ESLint
```
> npm run lint
> eslint src app.js
(Exit 0 - No errors or warnings)
```

### Unit Tests
```
> node --test tests/agent-rich-tools.test.js
▶ Phase 7: Agent Rich Tools — upsert_quiz
  ✔ upsert_quiz accepts plain string question title and reference answer (3359.7832ms)
  ✔ upsert_quiz converts rich block arrays in surveyJson.title and answerKey.modelAnswer (2177.1975ms)
  ✔ upsert_quiz converts chemistry blocks with mhchem syntax in question and referenceAnswer (2395.5786ms)
  ✔ upsert_quiz rejects invalid LaTeX math syntax in blocks (1172.4354ms)
  ✔ upsert_quiz rejects forbidden LaTeX commands in blocks (1099.4604ms)
  ✔ upsert_quiz accepts friendly questions array with rich blocks (1701.1409ms)
✔ Phase 7: Agent Rich Tools — upsert_quiz (11907.6829ms)
▶ Phase 7: Agent Rich Tools — grade_essay
  ✔ grade_essay accepts plain string feedback (1065.1625ms)
  ✔ grade_essay converts rich block array feedback into serialized envelope (992.6835ms)
  ✔ grade_essay rejects invalid LaTeX math in feedback (1122.5508ms)
  ✔ grade_essay accepts referenceAnswers and questionText with rich blocks (1055.5985ms)
✔ Phase 7: Agent Rich Tools — grade_essay (4237.3218ms)
▶ Phase 7: Agent System Prompt Instructions
  ✔ buildSystemPrompt includes rich math and chemistry instructions (17.4534ms)
✔ Phase 7: Agent System Prompt Instructions (17.7622ms)
▶ Phase 7: Model Transport Safety (Gemini schema stripping)
  ✔ toLangChainTools successfully converts upsert_quiz and grade_essay schemas (7.3504ms)
✔ Phase 7: Model Transport Safety (Gemini schema stripping) (7.465ms)
ℹ tests 12
ℹ suites 4
ℹ pass 12
ℹ fail 0
ℹ duration_ms 16810.1214
```

### Regression Tests
```
> node --test tests/agent-tools-contract.test.js tests/agent-actions-crud.test.js
✔ agent CRUD tools — catalogue contract (13.2097ms)
✔ agent CRUD tools — P2b semantics (182.4694ms)
✔ agent tools — registry contract (13.4561ms)
✔ agent tools — execute() guards (13.1058ms)
✔ agent tools — the payload char cap never hollows out an answer (0.7231ms)
✔ agent tools — LangChain wrapper (249.2084ms)
✔ agent tools — model-facing JSON Schema (Gemini transport) (30.7717ms)
✔ agent tools — the model-facing surface (Phase 1) (10.6027ms)
✔ agent tool micro-cache (Phase 4.5) (2.1766ms)
ℹ tests 43
ℹ pass 43
ℹ fail 0
```
