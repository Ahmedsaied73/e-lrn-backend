# PRD — Rich Math & Chemistry Answer Input for Essay Questions

Product: أكاديمية التميز e-learning platform (project folder: `e-learning-platform`)
Owner: Ahmed · Status: ready for implementation · Written: 2026-11-07
Companion files: `MATH_INPUT_IMPLEMENTATION_PLAN.md` (how), `MATH_INPUT_AGENT_PROMPT.md` (agent instructions)

> Conventions in this document
> - **VERIFY** = something I (the author) assumed about the codebase without seeing it. The agent confirms it in Phase 0 and records the real answer. If reality differs, the agent follows reality and reports the difference. It never silently guesses.
> - **DECISION** = already decided by Ahmed. **DEFAULT** = my recommendation, used unless Ahmed says otherwise.

---

## 1. Problem

Essay (مقالي) questions in math, physics and chemistry need equations: fractions, powers, roots, integrals, Greek letters, subscripts, chemical formulas. Today a student must type all of that with a normal phone/tablet/PC keyboard.

Consequences:
1. Typing is slow and exhausting, so students write less than they solved on paper.
2. Some structures cannot be typed at all. A fraction becomes `a/b` or a dash, and in a long expression it is ambiguous.
3. Because the answer is a flat string, a mistyped or ambiguous expression is read wrongly by the AI grader, and a correct student is graded wrong. This is the most damaging failure.
4. Teachers hit the same wall when they write the question and the **reference answer** that the AI grader uses.

## 2. Decision summary (DECISION, from Ahmed)

- Use a **visual math editor** (fractions appear as real fractions while typing, with a built-in on-screen symbol keyboard). Library: **MathLive** (`mathlive` on npm).
- **No photo / camera / image upload for now.** Not even as a fallback.
- The **teacher/admin uses the same editor** for the question text and for the reference answer given to the AI.
- **Handwriting input** is wanted as an option. It ships later, behind a feature flag (Phase 8).
- Subjects with no symbols (Arabic, English, ...) must keep working exactly as today with a normal text box.

## 3. Goals and non-goals

### Goals
- G1. A student can write a full multi-step solution (prose + equations + chemical equations) on phone, tablet or PC without knowing LaTeX.
- G2. What the student sees is what the grader and teacher receive. No guessing, no OCR.
- G3. Teachers/admins author question text and reference answer with the same tool.
- G4. Zero regression for subjects without math. Their answers are stored byte-for-byte as today.
- G5. No meaningful extra load: no new tables, no per-keystroke requests, the editor is lazy-loaded only where needed.
- G6. Everything the AI sees is validated server-side. Enforcement never depends on the frontend.

### Non-goals (v1)
- Photo upload, scanning, OCR of paper solutions.
- Diagrams, graphs, free-hand drawing, geometry figures.
- Drawing organic structures (benzene rings, skeletal formulas). Plain chemical *equations* are in scope.
- Computer-algebra auto-grading. Grading stays AI + teacher review (existing rule: AI never auto-publishes a score).
- Math in multiple-choice options. (Open item D4. The viewer component is reusable if wanted later.)
- Live sessions, anything unrelated to essay answers.
- Subject-specific pages (404, login, register, and their designs per subject or language). Deferred. Ahmed will install the physics and math page sets later and design them separately. This feature must not break or hardcode them (see agent rule 15).

## 4. Users and stories

**Student**
- S1. I answer an essay question by writing sentences and adding equation lines between them.
- S2. I tap "Equation", tap the fraction key, and type numerator and denominator in real boxes.
- S3. I find Greek letters (ω, α, θ, Δ, π, μ, λ, ρ, σ, φ), roots, powers, subscripts, integrals, sums, limits, vectors, ≤ ≥ ≠ ≈ ± × ÷ → on the on-screen keyboard.
- S4. I can reorder, edit and delete lines before I submit.
- S5. After submitting (or when time expires) I see my answer rendered correctly.
- S6. On a non-math subject I just see a normal text box.

**Teacher / Admin**
- T1. I write the question text with equations using the same tool.
- T2. I write the reference answer with equations. The AI uses it. Students never see it.
- T3. I choose per question whether the student answer is plain text or rich (math allowed). The default comes from the subject.
- T4. In the grading inbox I see each student's answer rendered, and the AI's feedback next to it.

**AI grader**
- A1. I receive the student answer and reference answer as clear text where equations are marked, so I can judge by mathematical meaning.

## 5. Content model (the contract between frontend, backend, AI)

An answer, a question prompt and a reference answer are all "rich content".

Block types:

| type | meaning | stored value |
|---|---|---|
| `text` | prose in any language (Arabic, English). Newlines allowed. | plain string |
| `math` | one display equation | LaTeX string from MathLive |
| `chem` | one chemical equation (editor ships in Phase 4b, the stored format is supported from Phase 1) | mhchem syntax, e.g. `2H2 + O2 -> 2H2O` |

Envelope (JSON string):

```json
{"v":1,"blocks":[{"t":"text","v":"Using Newton's second law:"},{"t":"math","v":"F=m\\cdot a"}]}
```

**Storage rule (important, protects non-math subjects):**
- If content contains **no** `math`/`chem` block, store the **plain string** exactly as today.
- If it contains at least one, store the envelope JSON **in the same text column**. No new answer table, no new answer column.
- Reading: if a stored string starts with `{"v":1,"blocks":[` and parses and matches the schema, it is rich. Otherwise it is legacy plain text. Old data keeps working with no backfill.

Question-level setting: `answerFormat` = `PLAIN` | `RICH` | null. Null (the default for every question) means follow the subject profile (section 6.4). A stored PLAIN or RICH overrides it.
- `PLAIN`: student sees a normal text box. The server rejects envelopes for these questions.
- `RICH`: student sees the block editor. The server accepts plain strings and envelopes.
- Question text and reference answer may be rich regardless of `answerFormat` (detected by the storage rule).

Limits (server-enforced): max 60 blocks, text block 4,000 chars, math block 2,000 chars, chem block 500 chars, whole serialized value 20,000 chars.

## 6. UX requirements

### 6.1 Student answer editor (`RichEditor`)
- Starts as one text block. Buttons: **+ Text**, **+ Equation**, **+ Chem equation** (only if enabled). Each block has move up/down and delete.
- Equation block = MathLive field. On touch devices the MathLive virtual keyboard opens on focus. On desktop the student can type naturally (`/` makes a fraction, `^` a power, `sqrt` a root, Greek names convert) and can open the keyboard with a button.
- Custom "Science" keyboard layout (Phase 4): fraction, root, power, subscript, ∫, Σ, lim, vector, π, Δ, θ, ω, α, β, λ, μ, ρ, σ, φ, ±, ×, ·, ≠, ≤, ≥, ≈, →, ⇌, ∞, degree sign, brackets. VERIFY the layout API in the installed MathLive version.
- Chem block = a plain input with a **live rendered preview** underneath (mhchem rendered by KaTeX). The student types `2H2 + O2 -> 2H2O`. This is deliberately simpler and more reliable than editing chemistry inside MathLive, where mhchem support is only partial.
- Incomplete equations (empty boxes, MathLive placeholders) are normalized and the block shows a non-blocking "incomplete" hint. Never block submission for this.
- Required-question semantics: "answered" means at least one block with non-whitespace content.
- Direction: the page may be RTL, but **every math field and rendered equation is `dir="ltr"`**. Text blocks use `dir="auto"` so Arabic and English paragraphs both look right.
- Touch targets at least 44px. When the on-screen keyboard opens, the active block scrolls into view and is not hidden.
- All new UI strings go through the project's locale mechanism (ar/en from the i18n migration). No hardcoded Arabic or English strings.

### 6.2 Read-only view (`RichView`)
- One component renders any stored value (plain or envelope) with KaTeX. Used in: quiz review, results pages, teacher grading inbox, admin preview, AI feedback context.
- No `dangerouslySetInnerHTML` for text blocks. Equation HTML only from `katex.renderToString` with `trust: false`.

### 6.3 Teacher / admin authoring
- Question form gets: rich **question text**, **answer format** toggle ("Allow equations in student answer"), rich **reference answer**, and any existing rubric/notes fields stay as they are unless Phase 0 shows they hold formulas.
- Default of the toggle comes from the existing per-subject config (VERIFY it exists and where): `richAnswerDefault` true for math/physics/chemistry, false for Arabic/English.
- Live preview of how the student will see the question.
- The reference answer is never returned by any student-facing endpoint (extends the existing `answerKey` hardening item). This gets an automated test.

### 6.4 Subject profiles (switched by the subject variable, never by language)

Each deployment has one subject variable (name confirmed in Phase 0). It decides the default answer format and which tools appear. Changing that one variable switches the feature on or off with no code change. The UI language is a separate variable and never affects the profile.

| Subject | Default answer format | Chemistry block | Notes |
|---|---|---|---|
| MATH | RICH | off | visual equation editor |
| PHYSICS | RICH | off | same as math. Diagrams are out of scope |
| CHEMISTRY | RICH | on (Phase 4b) | equations and calculations |
| ARABIC | PLAIN | off | plain text box, unchanged |
| ENGLISH | PLAIN | off | plain text box, unchanged |
| Unknown | PLAIN | off | logged warning, never an error |

A teacher can still set a single question to RICH or PLAIN, and a stored value always wins over the profile.

### 6.5 Subjects without symbols (Arabic, English, ...)
Answer: they just write normally. `answerFormat=PLAIN` shows the same text box as today and stores the same plain string. A teacher of such a subject can still turn on RICH for one question if they want an equation. There is no impact on them otherwise.

## 7. AI grading requirements

- The grader receives a text version where equations are wrapped: `$$ ... $$`, chemistry as `$$ \ce{...} $$`. Same conversion for the student answer and the reference answer.
- Prompt addition (exact text is in the plan): judge by mathematical equivalence, ignore typing-style differences, treat Arabic or Latin variable names as variables, say so in feedback if something is unreadable instead of guessing.
- Existing principles stay: AI never auto-publishes a score, full `criteriaBreakdown` is stored, golden test set catches prompt regressions. The golden set gets new math/chemistry cases.
- If the value fails validation or the grader fails, the existing fallback (human-graded inbox) applies.

## 8. Security

- Server validates every rich value on write (admin question save, student submit, and any admin-agent tool that writes essay content). Frontend validation is convenience only.
- KaTeX parse check with `trust: false`, `maxExpand` limit, denylist for dangerous commands, balanced-brace check for chem.
- LaTeX/mhchem content is never executed as code and never concatenated into HTML. Prompt-injection note: student text blocks reach the AI as they do today. Nothing new, but the grader prompt keeps the existing guardrails.
- No third-party CDN at runtime. MathLive fonts and KaTeX CSS/fonts are self-hosted (there is an existing Egyptian ISP blocking issue with some hosting domains, and the platform should not depend on a CDN during exams).

## 9. Performance and cost (the DB question)

| Concern | Answer |
|---|---|
| Database load | None added. LaTeX is a few hundred bytes. It goes into the existing answer text column. No new tables or indexes for answers. At most one nullable/defaulted column (`answerFormat`) on the question. |
| Extra requests | None per keystroke. The editor only changes local state. Submission and any existing autosave send one string, the same number of requests as today. |
| Payload | Capped at 20 KB per answer. Typical solution is 1 to 4 KB. |
| Frontend bundle | MathLive is lazy-loaded (dynamic import, client-only) and only on pages that render a RICH question. Non-quiz pages must not grow. Measured in Phase 9. |
| Backend CPU | Validation parses at most 60 small blocks per submission. Bounded by the limits. Profile in Phase 9. |
| AI cost | LaTeX adds some tokens per essay. Bounded by the 20 KB cap. |
| Handwriting (Phase 8) | The only feature with a per-use cost (about 0.2 cent per conversion with Mathpix strokes at current published pricing). Off by default. |

## 10. Handwriting (Phase 8, flagged off)

- A "✍ Write" button on an equation block opens a drawing pad. The student writes an equation with finger or stylus.
- Strokes (coordinates only, no image) go to our backend, which calls a recognizer and returns LaTeX. Nothing is stored.
- The result lands in the equation block as a **draft the student reviews and corrects** in the visual editor before anything counts. Recognition output is never trusted on its own.
- Provider is behind an interface. DEFAULT: Mathpix strokes API (math-specific, takes strokes directly, published price $0.002/request, plus a one-time account setup fee on pay-as-you-go: verify current terms before signing up). Alternative to evaluate: MyScript iink SDK (commercial, requires an application key). Not chosen yet, see D1.
- Needs: per-user rate limit, daily budget cap, kill switch (env flag).

## 11. Risks and how each one is retired (R1 to R4 are Phase 0 spikes)

| # | Risk | Spike |
|---|---|---|
| R1 | Arabic letters/digits as variables (س ص ع, ٢٣) may not render or edit correctly inside math mode in MathLive or KaTeX. Egyptian Arabic-medium students use them. | S1: type `س^2+ص^2=٢٥` in MathLive, store, render with KaTeX. If KaTeX shows tofu or warns, fallback rule: wrap Arabic runs in `\text{...}` during normalization. Decide with evidence. |
| R2 | MathLive's LaTeX may use macros KaTeX does not know (e.g. `\differentialD`, `\exponentialE`, `\imaginaryI`), or leave `\placeholder{}`. | S2: corpus test, MathLive `getValue("latex-expanded")` into KaTeX with `throwOnError: true`. Store `latex-expanded` and normalize placeholders. |
| R3 | MathLive touches `window`/`customElements`. Next.js 13 App Router SSR can break. | S3: client component + dynamic import. Production build must pass. |
| R4 | SurveyJS custom question may fight the existing quiz logic (timer, resume, required, readOnly). | S4: minimal `richanswer` question mounted in the real quiz page, read/write value, required and readOnly verified. Do not touch the known timer/resume bug logic. |
| R5 | iOS Safari / Android Chrome: virtual keyboard overlap, viewport jumps, focus loss. | Manual device checklist in section 4 of the plan (used at Gate 3 and Phase 9). |
| R6 | mhchem coverage in KaTeX is not 100% of mhchem. | Chem block shows a live preview. If it fails to render, the block shows an error and is still stored as text. |
| R7 | LaTeX package/version drift between frontend and backend (two repos). | Shared fixture file `rich-contract-fixtures.json` copied identically in both repos, tested on both sides. |

## 12. Acceptance criteria (testable)

Contract / backend
- AC-1. `parseRich` returns identical results for the shared fixtures in both repos.
- AC-2. Plain strings round-trip unchanged: `serializeRich(parseRich(x)) === x` for 100% of the plain-text fixtures, including Arabic.
- AC-3. A text-only block list serializes to a plain string, never an envelope.
- AC-4. Server rejects: oversize values, malformed envelope, forbidden commands, unbalanced chem braces, invalid LaTeX (error codes below). Server accepts all valid fixtures.
- AC-5. For an `answerFormat=PLAIN` question the server rejects an envelope with a math block.
- AC-6. No student-facing endpoint returns the reference answer (test over every student route that returns question data).
- AC-7. Existing quiz/essay tests still pass. Old answers (plain) display unchanged.

Student experience
- AC-8. On a RICH question the student can build: text, equation `\frac{a+b}{c}`, text, equation with `\sqrt{}`, `\int_0^1 x^2\,dx`, a Greek letter, a subscript, and submit. The stored value is a valid envelope.
- AC-9. Same on iPhone Safari, Android Chrome, desktop Chrome and Firefox, tablet.
- AC-10. A PLAIN question shows the unchanged text box.
- AC-11. A required RICH question with only empty blocks is treated as unanswered.
- AC-12. Arabic variable test (R1) behaves as decided in the spike report.
- AC-13. After submit or expiry the answer renders read-only with correct equations.

Teacher / AI
- AC-14. Admin can write question text and reference answer with equations, preview them, save, re-open and edit.
- AC-15. The grader input for a rich answer contains `$$ ... $$` equations and the new prompt block. Golden set results are reviewed by Ahmed: equivalent forms (`\frac12`, `0.5`) score the same, a sign error scores lower.
- AC-16. Teacher grading inbox shows rendered answers.

Non-functional
- AC-17. No new JS on non-quiz routes. MathLive chunk loads only on RICH question pages (before/after build output attached).
- AC-18. No request fires per keystroke (network panel evidence attached).
- AC-19. Flag off (`NEXT_PUBLIC_RICH_INPUT_ENABLED=false`) returns the platform to today's behavior, and stored rich answers still display (as rendered view or readable plain preview).
- AC-20. All new strings exist in both locales. Lint, type-check, build and tests are clean on both repos.

Error codes (server): `RICH_TOO_LARGE`, `RICH_BAD_FORMAT`, `RICH_FORBIDDEN_COMMAND`, `RICH_BAD_MATH`, `RICH_NOT_ALLOWED` (envelope sent to a PLAIN question). Messages go through the existing backend locale mechanism.

## 13. Open items for Ahmed (not assumed, defaults used so work is not blocked)

- D1. Handwriting provider and budget. DEFAULT: Phase 8 stays off until Ahmed picks. Evaluate Mathpix strokes first.
- D2. Chemistry blocks in the first release or the second? DEFAULT: second (Phase 4b), math first.
- D3. Resolved by the subject variable: MATH, PHYSICS and CHEMISTRY default to RICH, ARABIC and ENGLISH to PLAIN (section 6.4).
- D4. Do multiple-choice options need equations too? DEFAULT: no, later.
- D5. Should the admin chat agent (Gemini) be able to create/edit essay questions with equations through chat? DEFAULT: yes, Phase 7, only if Phase 0 finds such tools.
