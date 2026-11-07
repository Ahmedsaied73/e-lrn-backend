# Implementation Plan — Rich Math & Chemistry Answer Input

Companion to `MATH_INPUT_PRD.md` (read it first). The agent prompt is `MATH_INPUT_AGENT_PROMPT.md`.

Read this plan top to bottom before touching code. Execute phases in order.

## 0. How to execute this plan

### 0.1 Rules that apply to every phase
1. **Phase 0 comes first and is read-only.** It confirms every **VERIFY** item against the real code. Where reality differs from this plan, follow reality and report the difference. Never silently guess a file name, table name, route or function.
2. **BE** = backend part of the project, **FE** = frontend part. VERIFY whether they are two repos/folders or one monorepo. Branch name in each: `feature/rich-math-input`, created from `Dev` (VERIFY that `Dev` is the working branch in both).
3. Allowed new dependencies, nothing else without asking Ahmed: FE `mathlive`, `katex`, `@types/katex` (dev). BE `katex`. (`zod` is already used by the AI grading code, VERIFY, reuse it.)
4. No edits outside the files a phase needs. Remove dead code or stale comments **only** in files you already have to touch.
5. Every phase ends with: lint, type-check, build, tests (commands from `package.json`, VERIFY names), a `PHASE_N_REPORT.md`, and a commit. **Always write the report.** A previous phase of another feature shipped without one and that cost review time.
6. **Hard gates (stop and wait for Ahmed):** after Phase 0, Phase 1 (DB migration), Phase 3 (first end-to-end flow), Phase 6 (golden set review), before Phase 8, and at the end of Phase 9. Between gates, continue automatically.
7. **Database safety.** Before any Prisma migration: print the host part of `DATABASE_URL` (never the password), state whether it is dev/staging/prod, and wait for Ahmed to confirm it is the dev database. Create migrations with `--create-only`, show the SQL, then apply. Never run `migrate deploy` against staging/prod. Ahmed does that.
8. All user-facing strings go through the project's locale mechanism (ar/en, see the i18n migration). Zero hardcoded Arabic or English UI strings. Server errors use the backend's own locale mechanism.
9. Never print, log or commit secrets. Never put the reference answer in any student-facing response.
10. Talk to Ahmed in Egyptian Arabic (colloquial). Code, comments, file names, reports in English.

### 0.2 Architecture at a glance

```
Student (FE)                         Backend                          AI grader
------------                         -------                          ---------
RichEditor (blocks)                  validateRich(raw)                toGraderText(answer)
  text  -> <textarea dir=auto>         parse + limits + KaTeX check    toGraderText(reference)
  math  -> MathLive <math-field>       reject RICH_* codes             + RICH_GRADING_RULES prompt block
  chem  -> input + KaTeX preview     stores ONE string in the
serializeRich(blocks) -> string      existing answer column
        |  (plain string if no math/chem, else JSON envelope)
        v
SurveyJS custom question "richanswer"  -->  POST answer (same endpoint, same shape)

Everywhere an answer/question/reference is shown:  <RichView value=... />  (KaTeX, read-only)
```

---

## Phase 0 — Discovery and spikes (READ-ONLY, then STOP)

Goal: replace every assumption with a fact, and retire risks R1 to R4 with evidence.

### 0.1 Map the codebase
Produce `RICH_INPUT_DISCOVERY.md` at the project root with a table `item | file path | line(s) | notes` for each item below. For each, write "NOT FOUND" if absent. Do not edit code.

Backend
1. Prisma model of essay / short-answer questions. Column holding the question text, reference answer / `answerKey`, rubric, points. Column type of each (must be `TEXT`, not a short `VARCHAR`).
2. Prisma model of the student's answer for essay questions (attempt/answer tables). Column type.
3. Controller + service for: create/update question (admin), submit answer (student), get quiz for taking (student), get results (student), grading inbox (teacher/admin).
4. Every student-facing route that returns question data. Confirm none returns the reference answer / `answerKey`. List any that does.
5. The AI essay grading service: file, prompt, how question + reference + student answer are inserted, Zod schema of the response, `criteriaBreakdown` storage, the golden test set (where, how it is run), the human-graded fallback.
6. The admin chat agent (`src/services/agent`): any tool that creates/updates quiz questions or essay content, and its input schema.
7. Validation layer and error format (how errors are returned, how messages are translated from the backend locale env).
8. Rate limiting and body-size limits that apply to the submit-answer route.

Frontend
9. How SurveyJS is created for a quiz: file, how backend questions are converted into SurveyJS JSON, which SurveyJS question type is used for essay questions today (`comment`? `text`?), where answers are read from the survey and sent to the API, whether answers are autosaved and how often.
10. Where the quiz timer, expiry and resume logic lives (do not change it, only know it).
11. Every component/page that displays an essay answer, question text or AI feedback: student results, review pages, `/me/user/all-exam-results` if it exists, teacher/admin grading inbox, admin question preview. List each with how text is rendered today (e.g. `whitespace-pre-wrap`).
12. The admin question form (old and new, since admin pages are being rebuilt). State which one is current and whether the old one is scheduled for removal.
13. The subject variable (Ahmed's per-deployment subject setting, name unknown, VERIFY). Find: its name, whether it is an environment variable or stored in the DB / frontend per-subject config, where it is read (BE, FE or both), its shape, and every subject value that exists in the code today. Report the full list. Also find the existing frontend per-subject config and whether it uses the same key.
14. i18n mechanism: dictionary files, hook/function to translate, how RTL/LTR is switched, whether the i18n migration has landed.
15. Next.js version (13 App Router expected), TypeScript config, path aliases (`@/`), CSS approach (Tailwind + shadcn/ui), existing ESLint rules, existing Playwright/CI setup and env variable names (`CI_TEST_BACKEND_URL`).
16. Existing `postinstall`/`prebuild` scripts in `package.json`.

### 0.2 Spikes (scratch branch `spike/rich-input`, never merged)

Add a throwaway client page in the FE with a MathLive field and a KaTeX output. Install `mathlive` and `katex` there only.

- **S1 — Arabic glyphs (R1).** In a MathLive field, enter via the real keyboard: `س^2+ص^2=٢٥`, and `\text{ثابت}=5`. Read `getValue("latex-expanded")`. Render with KaTeX using `{ throwOnError:false, strict:"ignore", trust:false }`. Capture screenshots. Record: does MathLive accept the characters? Does KaTeX render real glyphs, tofu boxes or console warnings? Decision rule: if rendering is correct, no change. If not, add `wrapArabicInText()` to `normalizeMathLatex` (wrap Arabic runs found outside `\text{}` in `\text{...}`) and re-test. Also test Arabic-Indic digits in text blocks.
- **S2 — MathLive to KaTeX corpus (R2).** Use the corpus in Appendix B. For each valid expression: set it into MathLive via `setValue`, read `getValue("latex-expanded")`, then `katex.renderToString(...,{throwOnError:true, trust:false, strict:"ignore", maxExpand:1000})`. All must pass. Also type these by hand in the field and check the output for: `\differentialD`, `\exponentialE`, `\imaginaryI`, `\placeholder`. Report every command found that KaTeX rejects, and the fix.
- **S3 — Next.js build (R3).** Put the MathLive component in a `"use client"` file that imports `mathlive` dynamically inside `useEffect`. Run `next build` and `next start`. Must build with no SSR error and no hydration warning. Self-host fonts (see Phase 2). Record First Load JS of the spike route.
- **S4 — SurveyJS mount (R4).** Register a minimal `richanswer` question (Appendix A.5) in the real quiz page on the spike branch. Confirm: value writes to the survey data, `isRequired` works through `isEmpty()`, read-only/display mode renders, and the timer/submit/resume code path behaves exactly as with the old essay question. Do not fix existing bugs.
- Also confirm: MathLive `latex-expanded` is available in the installed version and what `MathfieldElement.fontsDirectory` and `soundsDirectory` expect. The MathLive docs list the static `fontsDirectory` option (default `./fonts`, fonts live in the npm package's `fonts` folder).

Deliverables: `RICH_INPUT_DISCOVERY.md`, `PHASE_0_REPORT.md` (spike results with screenshots/paths and the decisions taken), and a list of every VERIFY item with its real answer.

**GATE 0.** Stop. Give Ahmed a short summary in Egyptian Arabic: what exists, what differs from the plan, spike outcomes, and anything needing his decision.

---

## Phase 1 — Contract and backend enforcement

Goal: the server can store, validate and convert rich content. No UI yet.

### 1.1 Shared contract module
Create the module in both parts (folder names VERIFY against conventions): BE `src/lib/richContent/` and FE `lib/richContent/`. Reference implementation is in Appendix A.1 to A.3. Files: `types.ts`, `parse.ts`, `serialize.ts`, `normalize.ts`, `grader.ts`, `index.ts`. BE additionally has `validate.ts`.

The two copies of `types/parse/serialize/normalize/grader` must be identical. Put a header comment in each: "Keep identical to the other repo's copy. Contract fixtures: `rich-contract-fixtures.json`."

### 1.2 Shared fixtures
Create `rich-contract-fixtures.json` (identical in BE and FE) from Appendix B:
```json
{ "plain": ["..."], "rich": [{ "raw": "...", "blocks": [] }], "invalid": [{ "raw": "...", "code": "RICH_BAD_MATH" }] }
```
Each side has a test that loads it and asserts: parse results, plain round-trip, text-only serialization, and (BE only) validation codes.

### 1.3 Database
Only if Phase 0 finds no suitable place for a per-question format flag:
```prisma
enum AnswerFormat { PLAIN RICH }
// on the essay question model (name VERIFY):
answerFormat AnswerFormat?   // NULL = follow the subject profile (1.6)
```
Migration is additive: enum + nullable column with no default. Existing questions stay NULL, so they follow their subject profile automatically. On Postgres 11+ (Supabase) this is a metadata-only change, no table rewrite, no backfill, safe with live data. If any answer/question text column found in Phase 0 is not `TEXT`, add `ALTER COLUMN ... TYPE TEXT` to the migration. Follow the database safety rule 0.1.7. **GATE 1 includes the SQL and DB-host confirmation.**

### 1.4 Enforcement points
- Admin create/update question: validate question text and reference answer with `validateRich`. Accept `answerFormat` as `PLAIN`, `RICH` or null (null = follow the subject profile).
- Student submit: for the essay question, load its effective format (stored value, or the subject profile when null). If effective is `PLAIN` and `looksRich(answer)` then `RICH_NOT_ALLOWED`. In all cases run `validateRich(answer)`.
- Student-facing serializers: assert reference answer / `answerKey` are never included. Add a test that walks every student route found in Phase 0 item 4. If any leaks today, fix the leak in this phase and say so in the report.
- Body-size: confirm the submit route's limit is above 20 KB, and do not raise any global limit.
- Error format: use the existing mechanism with codes `RICH_TOO_LARGE`, `RICH_BAD_FORMAT`, `RICH_FORBIDDEN_COMMAND`, `RICH_BAD_MATH`, `RICH_NOT_ALLOWED` and add messages to both backend locale dictionaries.
- The quiz-taking endpoint returns the **effective** format (already resolved with the subject profile), so the frontend never re-implements the rule. Admin endpoints return both the stored value and the effective value.

### 1.5 Tests (BE)
- Contract fixtures (parse, round-trip, serialize).
- Validator: every invalid fixture returns its code, every valid fixture passes, limits at boundary (exactly max and max+1).
- Submit route: PLAIN+plain ok, PLAIN+envelope rejected, RICH+plain ok, RICH+envelope ok, RICH+invalid rejected, legacy Arabic plain text unchanged.
- No-leak test for the reference answer.
- Existing suites still pass (note the known flaky auth-limiter test from other work, report separately if it flakes, do not "fix" it here).

Done when: tests green, build green, migration SQL reviewed, `PHASE_1_REPORT.md` written. **GATE 1.**

---

### 1.6 Subject profiles (driven by the subject variable, never by language)

Why: each deployment has a subject, and the subject decides which tools appear. Changing that one variable must switch the feature on or off with no code change. The UI language is a separate variable and never affects this.

1. Use what Phase 0 item 13 found. If the subject is stored per question in the DB instead of per deployment, stop and report it. The profile must then come from each question's subject.
2. Create `lib/subjectProfile.ts` in BE and FE (identical copies, like the contract module):
```ts
export type SubjectProfile = { defaultFormat: "PLAIN" | "RICH"; allowChem: boolean };
export function subjectProfile(subject: string | null | undefined): SubjectProfile;
```
Keys must match the real values from Phase 0 (VERIFY):

| subject | defaultFormat | allowChem | notes |
|---|---|---|---|
| MATH | RICH | false | editor from Phase 2 |
| PHYSICS | RICH | false | same as math. Diagrams are not supported (PRD non-goals) |
| CHEMISTRY | RICH | true | chem editor arrives in Phase 4b. Until then, math blocks only |
| ARABIC | PLAIN | false | unchanged behavior |
| ENGLISH | PLAIN | false | unchanged behavior |
| unknown or missing | PLAIN | false | log one warning at startup, never throw. Ask Ahmed before adding a key |

3. Effective format = `answerFormat` when set on the question, otherwise `subjectProfile(subject).defaultFormat`. Backend resolves it and returns the effective value to the frontend.
4. Both repos read the same variable. Each repo has a test that loads the variable and asserts the profile.
5. No code path may read the UI locale to choose a profile. Add a unit test that `subjectProfile` takes only the subject value.

Tests (must pass at Gate 1, repeated in Phase 3 and Phase 9):
- Matrix: subject in {MATH, PHYSICS, CHEMISTRY, ARABIC, ENGLISH} × locale in {ar, en} = 10 runs. Format and allowChem match the table in every run. Changing the locale changes nothing.
- Unknown subject gives PLAIN and one logged warning.
- A question with stored `PLAIN` on a MATH deployment stays PLAIN (explicit value wins).
- A question with stored NULL on a MATH deployment becomes RICH with no DB write (auto-activation).

## Phase 2 — Shared frontend components (no quiz wiring yet)

Goal: `RichEditor` and `RichView` work in isolation on a dev-only page.

### 2.1 Install and assets
- `npm i mathlive katex` and `npm i -D @types/katex` in FE.
- Self-host MathLive fonts. Add `scripts/copy-mathlive-assets.mjs` that copies `node_modules/mathlive/fonts` to `public/mathlive/fonts`. Run it from `postinstall` (merge with any existing postinstall) and gitignore the output. Confirm the same works in the Vercel build.
- No CDN at runtime. KaTeX CSS is imported from the package (`katex/dist/katex.min.css`) so Next.js bundles it with its fonts.

### 2.2 Files (names VERIFY against FE conventions)
```
lib/richContent/*                       (Phase 1 copy)
types/mathlive.d.ts                     JSX typing for <math-field> (Appendix A.4)
components/rich/MathBlockEditor.tsx     "use client", dynamic import of mathlive (A.4)
components/rich/RichEditor.tsx          block list, add/move/delete (A.6)
components/rich/RichView.tsx            read-only KaTeX renderer (A.7)
components/rich/rich.css or Tailwind    block styles
app/dev/rich-input/page.tsx             dev-only demo, returns notFound() when NODE_ENV === "production"
```

### 2.3 Behavior to implement exactly
- Block state has client-only ids for React keys. Stored shape has no ids.
- `RichEditor` props: `value: string`, `onChange(value: string)`, `ariaLabel`, `readOnly?`, `allowChem?`, `maxBlocks?`. Emits `serializeRich(blocks)` on every change. It does not call the network.
- External `value` changes (draft restore) re-sync blocks only if the incoming string differs from the last string emitted.
- MathLive config on first load: `MathfieldElement.fontsDirectory = "/mathlive/fonts"`, `MathfieldElement.soundsDirectory = null`, keyboard policy `auto`, `dir="ltr"` on the element, `smartMode` off, `defaultMode` math. Confirm each option name against the installed version (VERIFY, the docs list `fontsDirectory`, `smartMode`, `defaultMode` and `mathVirtualKeyboardPolicy` with values `auto`/`manual`/`sandboxed`).
- Value read: on the field's `input` event, call `getValue("latex-expanded")` then `normalizeMathLatex` (strips `\placeholder{}` to `{}`). Track `incomplete` when a placeholder was present and show a non-blocking hint.
- Value write: `setValue(latex, { silenceNotifications: true })` only when it differs from the current field value, to avoid loops.
- Buttons: "Add text", "Add equation", move up, move down, delete, "Open keyboard" (for desktop). A newly added equation block autofocuses.
- Empty-block cleanup happens inside `serializeRich`, not in the UI, so the student can keep an empty block while thinking.
- RTL: block container follows page direction. Equation always `dir="ltr"`. Text block `dir="auto"`. Verify with Arabic UI and English UI.
- A11y: every block has an `aria-label` from locale keys. Keyboard users can add, move and delete blocks. Min touch target 44 px.
- i18n keys (English source, Arabic added by the agent and reviewed by Ahmed): `rich.addText`, `rich.addEquation`, `rich.addChem`, `rich.moveUp`, `rich.moveDown`, `rich.delete`, `rich.openKeyboard`, `rich.incomplete`, `rich.textLabel`, `rich.equationLabel`, `rich.chemLabel`, `rich.chemHint`, `rich.limitReached`, `rich.errorTooLarge`, `rich.errorBadMath`.

### 2.4 Tests
- Unit (Vitest was cancelled for this repo, so use whatever test runner exists, VERIFY; if none, use Playwright component-less e2e on the dev page): `RichView` renders plain text, an envelope with `\frac`, a malformed envelope as plain text, and Arabic text with `dir="auto"`.
- E2E on `/dev/rich-input`: add equation, type `1/2` (becomes a fraction), read stored value contains `\frac{1}{2}`. Add text with Arabic. Reorder. Delete. Serialize back: text-only gives a plain string.
- Network assertion: typing in an equation fires zero requests.

### 2.5 Manual device checklist (Ahmed does this at GATE 3, but the agent prepares the page)
See section 4.

Done when: dev page works, build passes, `next build` route-size table for the dev page and one unrelated page recorded in `PHASE_2_REPORT.md`.

---

## Phase 3 — Student quiz integration and every place an answer is displayed

Goal: a student can answer a RICH essay question end to end, and everyone sees it rendered.

### 3.1 SurveyJS custom question
- Create `components/rich/survey/richanswer.tsx` from Appendix A.5. Register it once from a client-only module that runs before the `Model` is created (`registerRichAnswer()`).
- In the function that converts backend questions to SurveyJS JSON (Phase 0 item 9): if an essay question's effective format (from the backend, 1.6) is `RICH` and the flag `NEXT_PUBLIC_RICH_INPUT_ENABLED === "true"`, emit `type: "richanswer"`. Otherwise emit what is emitted today. PLAIN questions must produce byte-identical SurveyJS JSON to before (add a test).
- Required semantics through `isEmpty()`.
- Read-only/display mode renders `RichView`.
- Question title/description may be rich: render the question prompt through `RichView` wherever the quiz renders titles for essay questions (use SurveyJS markdown hook `onTextMarkdown` or a custom title renderer, whichever the existing code already uses. VERIFY. If the existing code already renders titles through a custom component, use that).
- Do not touch timer, resume, gate or submit logic. If the new component exposes an existing bug, report it, do not fix it here.
- If Phase 0 item 9 shows autosave posts on every value change, add a debounce of 1500 ms **at that call site only** and note it in the report. If autosave does not exist, add nothing.

### 3.2 Display surfaces
For every surface in Phase 0 item 11, replace raw rendering of an answer, question text or reference with `<RichView value={...} />`. `RichView` handles plain strings identically to today (preserve line breaks). Surfaces: quiz review, student results, `/me/user/all-exam-results` if present, teacher/admin grading inbox, admin question preview, AI feedback header that quotes the answer.
For list rows or notifications that show a one-line snippet, use `toPlainPreview(raw, 120)` (Appendix A.3).

### 3.3 Tests
- PLAIN question: SurveyJS JSON identical to before; student textbox identical.
- RICH question: answer with text + `\frac{a+b}{c}` + `\sqrt{x}` submitted, stored string is a valid envelope, reload shows it rendered.
- Required RICH question with only empty blocks cannot be submitted (existing required behavior).
- After expiry/submit, the answer renders read-only.
- Subject switch test (local run): set the subject variable to PHYSICS and restart. A question with no stored format shows the rich editor. Set it to ARABIC, same question shows the plain textbox. No DB change in between.
- Playwright smoke (existing CI pattern, gated on `CI_TEST_BACKEND_URL`).

Done when: tests green, `PHASE_3_REPORT.md` with screenshots. **GATE 3:** Ahmed tries it on his phone, tablet and PC using the section 4 checklist.

---

## Phase 4 — Science keyboard and chemistry block

### 4a — Science keyboard layout
Add a custom MathLive virtual keyboard layout "Science" (fraction, root, power, subscript, integral, sum, limit, vector, π Δ θ ω α β λ μ ρ σ φ, ± × · ÷ ≠ ≤ ≥ ≈ → ⇌ ∞ °, brackets, undo/redo) in addition to the default numeric/symbol/greek layouts. API for layouts is VERIFY (MathLive's `mathVirtualKeyboard.layouts`). Layout labels come from locale keys. Test that every key inserts valid LaTeX (corpus check through the same S2 pipeline).

### 4b — Chem block
- `ChemBlockEditor`: a plain `<input dir="ltr" autocapitalize="off" autocorrect="off" spellcheck="false">` plus a live KaTeX preview of `\ce{<value>}` using `katex/contrib/mhchem`. Below it, a hint line with 3 examples from locale keys. Optional small buttons: arrow `->`, equilibrium `<=>`, gas `^`, precipitate `v`, heat `[\Delta]` (each inserts text at the cursor).
- Enabled only when the subject profile says `allowChem` (CHEMISTRY, section 1.6). No per-question override in v1.
- Server already validates chem blocks (Phase 1): balanced braces + KaTeX parse + denylist.
- Tests: chem fixtures render; invalid shows an inline error and still stores text.

---

## Phase 5 — Admin / teacher authoring

Goal: teachers write rich question text and reference answers, and choose the answer format.

- Create `RichField` (label + `RichEditor` + "Preview as student" toggle that shows `RichView`). Props contract documented in the file header so the rebuilt admin pages can reuse it.
- Wire into the **current** admin question form (Phase 0 item 12): question text, reference answer. Add the "Allow equations in student answer" toggle bound to `answerFormat` (checked means `RICH`). The toggle has three states: follow subject (NULL, the default, shows the profile's effective value), allow equations (RICH), plain (PLAIN). Default comes from the subject profile (1.6), not from a separate config key. If the old admin form is scheduled for removal, implement `RichField` and the contract only, wire it into the new admin pages if they exist, and tell Ahmed what is left.
- Save path sends strings produced by `serializeRich`. Load path uses `parseRich`.
- The reference answer field label must say the student never sees it (locale key).
- Tests: create a question with equation text and reference answer, reopen, edit, preview. Student fetch of the same question contains no reference answer (assert on the response).

---

## Phase 6 — AI grader

Goal: the grader reads equations as mathematics.

1. In the grading service (Phase 0 item 5), convert both the student answer and the reference answer with `toGraderText(raw)` before building the prompt. For plain strings this returns the string unchanged.
2. If either converted text contains `$$`, append `RICH_GRADING_RULES` (below) to the existing system prompt. For plain essays the prompt is unchanged, so there is no token or behavior change for Arabic/English subjects.
3. Do not change the response schema or the `criteriaBreakdown` storage. Do not change the "never auto-publish a score" rule.
4. Cap: if the converted text is longer than the existing grader input cap (VERIFY), fall back to the existing human-graded path.

```text
RICH_GRADING_RULES
The student answer and the reference solution may contain mathematics written in LaTeX between $$ and $$, and chemistry written as \ce{...}. Read them as mathematics, not as plain text.
- Judge by mathematical equivalence, not notation. 1/2, 0.5 and \frac{1}{2} are the same. 2x and x\cdot 2 are the same. A different valid solution method is acceptable unless the rubric requires a specific method.
- Do not deduct marks for how an equation was typed (spacing, \left and \right, \cdot versus \times, \dfrac versus \frac).
- Variable names may be Arabic letters (for example س and ص) or Latin letters. A consistent renaming is the same variable.
- Units, significant figures and the constant of integration matter only if the rubric says so.
- If an expression is unreadable or malformed, say so in the feedback. Do not guess what the student meant, and do not award marks for the unreadable part.
- Chemical equations: check formulas, balance and conditions as the rubric requires.
```

### 6.1 Golden set additions
Add these cases to the existing golden set (live model calls are run manually, for example `GOLDEN_LIVE=1`, at most about 30 calls, to stay inside the free tier; keep the existing run mechanism, VERIFY). Each case needs question, reference (rich), student answer (rich), rubric, and expected band (full / partial / low).
1. Final answer `0.5` vs reference `\frac{1}{2}` → full.
2. Same solution with variables س, ص instead of x, y → full.
3. Sign error in the final answer → partial.
4. Correct final answer, steps missing while the rubric requires steps → partial.
5. Correct answer, unit missing while the rubric requires it → deducted.
6. Wrong formula with correct arithmetic → low.
7. Malformed equation block (`\frac{1}{`) → feedback mentions it is unreadable, no marks for that part.
8. Chemistry: balanced equation vs unbalanced equation → full vs partial.
9. Alternative valid method (completing the square vs formula) → full.
10. Text-only answer to a RICH question → graded as today.
11. Arabic prose mixed with equations → graded on content.
12. `\cdot` vs `\times`, `\dfrac` vs `\frac` → no deduction.
13. Indefinite integral missing `+C` where the rubric requires it → deducted.
14. Physics vector direction wrong → partial.

Done when: golden results table written to `PHASE_6_REPORT.md` with the model's feedback text per case. **GATE 6:** Ahmed reviews the table.

---

## Phase 7 — Admin chat agent (only if Phase 0 item 6 found tools that write essay content)

- Extend those tools' input schemas so question text and reference answer accept either a plain string or an array of blocks `[{t,v}]`. The server converts blocks with `serializeRich` and validates with `validateRich`. The model never has to write the JSON envelope by hand.
- Add 3 lines to the agent system prompt: use `math` blocks with LaTeX for equations, `chem` blocks for chemical equations, never mix prose into math blocks.
- Respect the existing agent rules (confirmation flows, bulk caps). Do not change them.
- Test: through chat, create an essay question with an equation, then open it in the admin form and see it rendered.
If no such tools exist, write "Phase 7 not applicable" in the report and continue.

---

## Phase 8 — Handwriting (flagged off, needs Ahmed's decision D1 first)

**Do not start until Ahmed has chosen a provider and a budget.** Default recommendation: Mathpix strokes API (math-specific, strokes in, no image; published price $0.002 per request at the time of writing, verify current terms and account setup fee before signing up). Alternative to compare: MyScript iink SDK.

### 8.1 Backend
- Env: `HANDWRITING_ENABLED=false`, provider keys, `HANDWRITING_DAILY_BUDGET` (max conversions per day, hard stop).
- `POST /api/handwriting/recognize`, authenticated students only. Body `{ strokes: { x: number[][], y: number[][] } }`.
- Validate: arrays same length, at most 80 strokes, at most 6,000 points total, all numbers finite, body under 100 KB.
- Rate limit with the existing Redis limiter: 20 requests per minute per user.
- Provider interface `HandwritingRecognizer.recognize(strokes): Promise<{ latex: string | null }>`. Mathpix implementation reads `latex_styled`, falls back to the `text` field (Mathpix returns `latex_styled` only for some inputs, so a client that reads only that field can silently show nothing). 8-second timeout. Provider credentials stay on the server. Verify the exact request and auth format against the Mathpix strokes reference before coding.
- Nothing about the strokes is stored or logged beyond counts.
- Response passes through `normalizeMathLatex` then a KaTeX parse check. Invalid result returns `latex: null`.

### 8.2 Frontend
- `HandwritingPad`: canvas with pointer events (`touch-action: none`), pen/finger/mouse, undo last stroke, clear, "Convert" button. Collects strokes as coordinate arrays only.
- Shown on an equation block only when `NEXT_PUBLIC_HANDWRITING_ENABLED === "true"`.
- On success, the LaTeX is placed in the equation block as a draft, the MathLive field is focused, and the student reviews and fixes it. Never auto-submit anything from recognition.
- Failure and rate-limit states show locale messages.

### 8.3 Tests
Stroke validation, rate limit, flag off returns 404, provider timeout handling (mock provider), pad e2e with synthetic pointer events and a mock recognizer.

---

## Phase 9 — Regression, performance, rollout

1. Full regression in BE and FE: lint, type-check, build, all tests.
2. Performance evidence (put in `PHASE_9_REPORT.md`):
   - `next build` route table before vs after. Non-quiz routes must not grow. The MathLive chunk is only loaded on pages rendering a RICH question.
   - Browser network panel screenshot: typing in an equation fires no request.
   - A RICH essay submit measured against a PLAIN essay submit locally (latency), and the validator's p95 time over the fixture corpus.
3. Flag behavior: `NEXT_PUBLIC_RICH_INPUT_ENABLED=false` gives today's UI, stored envelopes still display (read-only `RichView` always works).
4. Cleanup: remove the dev demo page if Ahmed does not want it, remove spike leftovers, make sure no unused imports/dead code in touched files.
5. Docs: append a section to the project's agent docs (`AGENTS.md`, `project_map.md`, VERIFY they exist) describing the contract, limits, error codes, flags and where each file lives.
6. Rollout plan for Ahmed (write it, do not run it): deploy with the flag off; run Prisma `migrate deploy` himself; turn the flag on for staging; test on devices; enable for one teacher; then all.
**GATE 9:** final report.

Rollback: set the flag off. RICH questions fall back to the plain text box (the server accepts plain strings for RICH questions). Existing envelope answers keep rendering through `RichView`. The `answerFormat` column is harmless and stays.

---

## 3.5 Deferred: subject-specific pages (do not build)

Subject-specific 404, login and register pages (different copy, layout and imagery per subject or language, e.g. the Arabic 404 pun and the chemistry 404 with a molecule) are out of scope. Ahmed will install the physics and math sets later and design them separately.

What this feature must do:
- Do not change, restyle or remove these pages.
- Do not hardcode their copy, layout or imagery in any shared component this feature touches.
- Keep every new string in locale keys, so per-subject pages can be swapped later without touching the editor.
- If a shared component blocks that later swap, note it in the phase report. Do not refactor it.

## 4. Device and scenario checklist (used at GATE 3 and Phase 9)

Devices: iPhone Safari, Android Chrome, iPad Safari (with and without keyboard), Windows Chrome, Windows Edge, Firefox desktop. Run each in Arabic RTL UI and English LTR UI.

For each:
1. Open a RICH essay question. Add text (type Arabic), add equation.
2. Open the on-screen keyboard, make `\frac{a+b}{c}`, then a nested fraction, a root, a power, a subscript, ω and Δ.
3. Type with the physical keyboard: `1/2`, `x^2`, `sqrt`, `alpha`.
4. Keyboard open: the active block is visible and the page scrolls normally.
5. Rotate the screen. Switch app and come back. The answer is still there.
6. Reorder and delete blocks. Add 60 blocks to see the limit message.
7. Submit. Reload. Open the review page. Everything renders.
8. Open the same attempt in the teacher grading inbox.
9. Open a PLAIN question (for example Arabic). It must look and behave exactly as before.
10. Arabic variable test: `س^2+ص^2=٢٥` renders as decided in S1.

---

## Appendix A — Reference code

Reference implementations. Adapt to project conventions (imports, aliases, i18n hook). Everything must compile and pass the tests in the plan. Where an API name is marked VERIFY, check the installed package's types.

### A.1 `types.ts` (identical in BE and FE)
```ts
export type RichBlock =
  | { t: "text"; v: string }
  | { t: "math"; v: string }
  | { t: "chem"; v: string };

export interface RichContent {
  v: 1;
  blocks: RichBlock[];
}

export const RICH_LIMITS = {
  maxBlocks: 60,
  maxTextChars: 4000,
  maxMathChars: 2000,
  maxChemChars: 500,
  maxTotalChars: 20000,
} as const;

export type AnswerFormat = "PLAIN" | "RICH";
```

### A.2 `parse.ts` and `serialize.ts` (identical in BE and FE)
```ts
import type { RichBlock, RichContent } from "./types";

const ENVELOPE_PREFIX = '{"v":1,"blocks":[';

export function looksRich(raw: unknown): raw is string {
  return typeof raw === "string" && raw.startsWith(ENVELOPE_PREFIX);
}

export function sanitizeBlocks(input: unknown): RichBlock[] | null {
  if (!Array.isArray(input)) return null;
  const out: RichBlock[] = [];
  for (const b of input) {
    if (!b || typeof b !== "object") return null;
    const { t, v } = b as { t?: unknown; v?: unknown };
    if ((t === "text" || t === "math" || t === "chem") && typeof v === "string") {
      out.push({ t, v });
    } else {
      return null;
    }
  }
  return out;
}

/** Plain strings (legacy or text-only) become a single text block. Never throws. */
export function parseRich(raw: string | null | undefined): RichContent {
  if (!raw) return { v: 1, blocks: [] };
  if (looksRich(raw)) {
    try {
      const data = JSON.parse(raw);
      const blocks = data && data.v === 1 ? sanitizeBlocks(data.blocks) : null;
      if (blocks) return { v: 1, blocks };
    } catch {
      /* fall through: treat as plain text */
    }
  }
  return { v: 1, blocks: [{ t: "text", v: raw }] };
}

function cleanBlocks(blocks: RichBlock[]): RichBlock[] {
  const out: RichBlock[] = [];
  for (const b of blocks) {
    if (b.v.trim() === "") continue;
    const last = out[out.length - 1];
    if (b.t === "text" && last && last.t === "text") {
      out[out.length - 1] = { t: "text", v: last.v + "\n" + b.v };
    } else {
      out.push({ t: b.t, v: b.v });
    }
  }
  return out;
}

/** Text-only content is stored as a plain string. Anything with math/chem is stored as the envelope. */
export function serializeRich(blocks: RichBlock[]): string {
  const cleaned = cleanBlocks(blocks);
  if (cleaned.length === 0) return "";
  if (cleaned.every((b) => b.t === "text")) {
    const plain = cleaned.map((b) => b.v).join("\n");
    return looksRich(plain) ? JSON.stringify({ v: 1, blocks: cleaned }) : plain;
  }
  return JSON.stringify({ v: 1, blocks: cleaned });
}

export function isEmptyRich(raw: string | null | undefined): boolean {
  return parseRich(raw).blocks.every((b) => b.v.trim() === "");
}

export function hasMath(raw: string | null | undefined): boolean {
  return parseRich(raw).blocks.some((b) => b.t !== "text");
}
```

### A.3 `normalize.ts` and `grader.ts` (identical in BE and FE)
```ts
// normalize.ts
const PLACEHOLDER = /\\placeholder(?:\[[^\]]*\])?\{[^{}]*\}/g;

export function hasPlaceholder(latex: string): boolean {
  return /\\placeholder\b/.test(latex);
}

/** Store only latex-expanded output from MathLive. Empty slots become {}. */
export function normalizeMathLatex(latex: string): string {
  return latex.replace(PLACEHOLDER, "{}").trim();
  // If spike S1 requires it, also wrap Arabic runs found outside \text{...} in \text{...}.
}
```
```ts
// grader.ts
import { parseRich } from "./parse";

/** For the AI grader. Plain strings are returned unchanged. */
export function toGraderText(raw: string | null | undefined): string {
  const { blocks } = parseRich(raw);
  const hasNonText = blocks.some((b) => b.t !== "text");
  if (!hasNonText) return raw ?? "";
  return blocks
    .map((b) => (b.t === "text" ? b.v : b.t === "math" ? `$$ ${b.v} $$` : `$$ \\ce{${b.v}} $$`))
    .join("\n");
}

/** One-line snippet for lists and logs. Not for display of equations. */
export function toPlainPreview(raw: string | null | undefined, max = 120): string {
  const s = parseRich(raw)
    .blocks.map((b) => b.v)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
```

### A.3b BE `validate.ts`
```ts
import katex from "katex";
// Registers \ce and \pu. VERIFY the correct import path for the installed katex version and module system.
require("katex/contrib/mhchem");
import { RICH_LIMITS } from "./types";
import { looksRich, sanitizeBlocks } from "./parse";

export type RichErrorCode =
  | "RICH_TOO_LARGE"
  | "RICH_BAD_FORMAT"
  | "RICH_FORBIDDEN_COMMAND"
  | "RICH_BAD_MATH";

export type RichValidation = { ok: true } | { ok: false; code: RichErrorCode; blockIndex?: number };

const FORBIDDEN =
  /\\(href|url|includegraphics|input|include|write|read|openin|openout|def|edef|gdef|xdef|let|newcommand|renewcommand|providecommand|catcode|csname|htmlClass|htmlId|htmlStyle|htmlData|special)(?![a-zA-Z])/;

function balancedBraces(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") { i++; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

export function validateRich(raw: string): RichValidation {
  if (raw.length > RICH_LIMITS.maxTotalChars) return { ok: false, code: "RICH_TOO_LARGE" };
  if (!looksRich(raw)) return { ok: true }; // plain text is always acceptable (size already checked)

  let data: any;
  try { data = JSON.parse(raw); } catch { return { ok: false, code: "RICH_BAD_FORMAT" }; }
  const blocks = data && data.v === 1 && Object.keys(data).length === 2 ? sanitizeBlocks(data.blocks) : null;
  if (!blocks) return { ok: false, code: "RICH_BAD_FORMAT" };
  if (blocks.length > RICH_LIMITS.maxBlocks) return { ok: false, code: "RICH_TOO_LARGE" };

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const max = b.t === "text" ? RICH_LIMITS.maxTextChars : b.t === "math" ? RICH_LIMITS.maxMathChars : RICH_LIMITS.maxChemChars;
    if (b.v.length > max) return { ok: false, code: "RICH_TOO_LARGE", blockIndex: i };
    if (b.t === "text") continue;
    if (b.t === "chem" && !balancedBraces(b.v)) return { ok: false, code: "RICH_BAD_MATH", blockIndex: i };
    const tex = b.t === "chem" ? `\\ce{${b.v}}` : b.v;
    if (FORBIDDEN.test(tex)) return { ok: false, code: "RICH_FORBIDDEN_COMMAND", blockIndex: i };
    try {
      katex.renderToString(tex, { throwOnError: true, trust: false, strict: "ignore", maxExpand: 1000 });
    } catch {
      return { ok: false, code: "RICH_BAD_MATH", blockIndex: i };
    }
  }
  return { ok: true };
}
```

### A.4 `types/mathlive.d.ts` and `MathBlockEditor.tsx`
```ts
// types/mathlive.d.ts
import type { MathfieldElement } from "mathlive";
declare global {
  namespace JSX {
    interface IntrinsicElements {
      "math-field": React.DetailedHTMLProps<React.HTMLAttributes<MathfieldElement>, MathfieldElement>;
    }
  }
}
export {};
```
```tsx
// components/rich/MathBlockEditor.tsx
"use client";
import { useEffect, useRef, useState } from "react";
import type { MathfieldElement } from "mathlive";
import { normalizeMathLatex, hasPlaceholder } from "@/lib/richContent";

type Props = {
  value: string;
  onChange: (latex: string, incomplete: boolean) => void;
  ariaLabel: string;
  readOnly?: boolean;
  autoFocus?: boolean;
};

export function MathBlockEditor({ value, onChange, ariaLabel, readOnly, autoFocus }: Props) {
  const ref = useRef<MathfieldElement>(null);
  const [ready, setReady] = useState(false);

  // Load MathLive only in the browser, only when this component mounts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { MathfieldElement } = await import("mathlive");
      if (cancelled) return;
      MathfieldElement.fontsDirectory = "/mathlive/fonts"; // self-hosted, VERIFY option name
      MathfieldElement.soundsDirectory = null;             // VERIFY
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // field -> parent
  useEffect(() => {
    const mf = ref.current;
    if (!ready || !mf) return;
    mf.mathVirtualKeyboardPolicy = "auto";
    mf.readOnly = !!readOnly;
    const handle = () => {
      const raw = mf.getValue("latex-expanded");
      onChange(normalizeMathLatex(raw), hasPlaceholder(raw));
    };
    mf.addEventListener("input", handle);
    return () => mf.removeEventListener("input", handle);
  }, [ready, onChange, readOnly]);

  // parent -> field (only when different, silently)
  useEffect(() => {
    const mf = ref.current;
    if (!ready || !mf) return;
    if (normalizeMathLatex(mf.getValue("latex-expanded")) !== value) {
      mf.setValue(value, { silenceNotifications: true });
    }
  }, [ready, value]);

  useEffect(() => {
    if (ready && autoFocus) ref.current?.focus();
  }, [ready, autoFocus]);

  return <math-field ref={ref} dir="ltr" aria-label={ariaLabel} style={{ display: "block", width: "100%", fontSize: "1.25rem" }} />;
}
```

### A.5 SurveyJS custom question `components/rich/survey/richanswer.tsx`
```tsx
"use client";
import { createElement } from "react";
import { ElementFactory, Question, Serializer } from "survey-core";
import { ReactQuestionFactory, SurveyQuestionElementBase } from "survey-react-ui";
import { RichEditor } from "../RichEditor";
import { RichView } from "../RichView";
import { isEmptyRich } from "@/lib/richContent";

export const RICH_ANSWER_TYPE = "richanswer"; // must be lowercase

export class QuestionRichAnswerModel extends Question {
  getType() { return RICH_ANSWER_TYPE; }
  isEmpty() { return isEmptyRich(this.value); } // required-question semantics. VERIFY override name in installed survey-core.
}

export class SurveyQuestionRichAnswer extends SurveyQuestionElementBase {
  get question(): QuestionRichAnswerModel {
    return this.questionBase as QuestionRichAnswerModel;
  }
  protected renderElement() {
    const q = this.question;
    if (q.isReadOnly) return <RichView value={q.value ?? ""} />;
    return (
      <RichEditor
        value={q.value ?? ""}
        onChange={(v: string) => { q.value = v; }}
        ariaLabel={q.title}
        allowChem={false /* Phase 4b: from question/subject config */}
      />
    );
  }
}

let registered = false;
export function registerRichAnswer() {
  if (registered) return;
  registered = true;
  Serializer.addClass(RICH_ANSWER_TYPE, [], () => new QuestionRichAnswerModel(""), "question");
  ElementFactory.Instance.registerElement(RICH_ANSWER_TYPE, (name) => new QuestionRichAnswerModel(name));
  ReactQuestionFactory.Instance.registerQuestion(RICH_ANSWER_TYPE, (props) =>
    createElement(SurveyQuestionRichAnswer, props)
  );
}
```
The registration pattern (model class extending `Question`, `Serializer.addClass`, `ElementFactory.Instance.registerElement`, a React class extending `SurveyQuestionElementBase`, `ReactQuestionFactory.Instance.registerQuestion`) follows the SurveyJS custom-question guide for React.

### A.6 `RichEditor.tsx` (outline the agent completes)
```tsx
"use client";
// State: EditorBlock = RichBlock & { id: string }  (ids are client-only)
// 1. blocks = parseRich(value).blocks mapped with ids; if empty, start with one empty text block.
// 2. every change: setBlocks(next); onChange(serializeRich(next.map(({id, ...b}) => b))).
// 3. keep lastEmitted ref; in an effect, if value !== lastEmitted.current, re-sync blocks from value.
// 4. render per block:
//      text -> <textarea dir="auto" rows auto-grow maxLength=RICH_LIMITS.maxTextChars aria-label=t('rich.textLabel')>
//      math -> <MathBlockEditor .../> (+ "incomplete" hint when flagged)
//      chem -> <ChemBlockEditor/> (Phase 4b)
//    each with Move up / Move down / Delete buttons (aria-labelled, min 44px).
// 5. footer buttons: Add text, Add equation, Add chem (only if allowChem), disabled at maxBlocks (show rich.limitReached).
// 6. no network calls, no debounce needed (pure local state).
```

### A.7 `RichView.tsx`
```tsx
import { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import "katex/contrib/mhchem";
import { parseRich } from "@/lib/richContent";

function MathHtml({ tex }: { tex: string }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(tex, { displayMode: true, throwOnError: false, trust: false, strict: "ignore", maxExpand: 1000 });
    } catch {
      return null;
    }
  }, [tex]);
  return html
    ? <div dir="ltr" className="my-2 overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />
    : <code dir="ltr">{tex}</code>;
}

export function RichView({ value, className }: { value: string | null | undefined; className?: string }) {
  const blocks = useMemo(() => parseRich(value).blocks, [value]);
  return (
    <div className={className}>
      {blocks.map((b, i) =>
        b.t === "text" ? (
          <p key={i} dir="auto" className="whitespace-pre-wrap">{b.v}</p>
        ) : (
          <MathHtml key={i} tex={b.t === "chem" ? `\\ce{${b.v}}` : b.v} />
        )
      )}
    </div>
  );
}
```
`dangerouslySetInnerHTML` is used only for `katex.renderToString` output with `trust: false`. Text blocks are plain React text.

---

## Appendix B — Fixture corpus

Valid math (write them into the fixtures file with JSON escaping):
```
\frac{a+b}{c}
\frac{1}{2}
x^{2}+y^{2}=z^{2}
\sqrt{b^{2}-4ac}
\sqrt[3]{x}
\int_{0}^{1}x^{2}\,dx
\sum_{n=1}^{\infty}\frac{1}{n^{2}}
\lim_{x\to 0}\frac{\sin x}{x}=1
\vec{F}=m\vec{a}
\omega=2\pi f
\Delta x=v_{0}t+\frac{1}{2}at^{2}
\theta=30^{\circ}
\alpha+\beta+\gamma=180^{\circ}
\begin{pmatrix}1&2\\3&4\end{pmatrix}
\left(\frac{a}{b}\right)^{2}
\frac{d}{dx}\left(x^{n}\right)=nx^{n-1}
\log_{2}8=3
\ln e=1
\overline{AB}\parallel\overline{CD}
\mathrm{m}/\mathrm{s}^{2}
\mu_{0}=4\pi\times10^{-7}
E=mc^{2}
\binom{n}{k}
x\leq 5,\ x\neq 3
\pm\sqrt{2}
\rho=\frac{m}{V}
\sin^{2}\theta+\cos^{2}\theta=1
\frac{\partial f}{\partial x}
\mathrm{d}x
\mathrm{e}^{i\pi}+1=0
\frac{\frac{1}{2}}{3}
x_{1,2}=\frac{-b\pm\sqrt{b^{2}-4ac}}{2a}
```
Arabic (spike S1, record the outcome, then keep as fixtures if they pass):
```
س^{2}+ص^{2}=٢٥
\text{ثابت}=5
```
Chem (mhchem syntax, stored in `chem` blocks):
```
2H2 + O2 -> 2H2O
N2 + 3H2 <=> 2NH3
CaCO3 ->[\Delta] CaO + CO2 ^
Fe^{3+} + 3OH^- -> Fe(OH)3 v
H2SO4 + 2NaOH -> Na2SO4 + 2H2O
Zn + Cu^{2+} -> Zn^{2+} + Cu
```
Invalid (expected code in brackets):
```
\frac{1}{                         [RICH_BAD_MATH]
\href{http://example.com}{x}      [RICH_FORBIDDEN_COMMAND]
\input{/etc/passwd}               [RICH_FORBIDDEN_COMMAND]
\def\a{\a\a}\a                    [RICH_FORBIDDEN_COMMAND]
\newcommand{\x}{y}\x              [RICH_FORBIDDEN_COMMAND]
\includegraphics{x.png}           [RICH_FORBIDDEN_COMMAND]
\write18{ls}                      [RICH_FORBIDDEN_COMMAND]
\unknowncommand{1}                [RICH_BAD_MATH]
}{                                [RICH_BAD_MATH]
chem block:  H2O} \href{x}{y      [RICH_BAD_MATH]
```
Envelope-level invalid: malformed JSON that starts with the prefix, `{"v":2,"blocks":[]}` as an envelope claim, block with unknown `t`, extra top-level keys, 61 blocks, a text block of 4,001 characters, total over 20,000 characters.
Plain fixtures: empty string, English sentence, Arabic paragraph with Arabic-Indic digits, text containing `$` and backslashes, text that looks like JSON but does not start with the envelope prefix.

Note: `\placeholder{}` is not invalid. `normalizeMathLatex` converts it to `{}` and the editor shows the "incomplete" hint.

---

## Appendix C — Report template (`PHASE_N_REPORT.md`)

```
# Phase N report
Branch / commit:
Done (bullets, outcome not process):
Differences from the plan (what was assumed vs what exists):
Files changed (paths):
Commands run and results (lint / types / build / tests, paste the tails):
Evidence (screenshots, network panel, build size table):
Open issues / bugs found but not fixed:
Decisions needed from Ahmed:
```
