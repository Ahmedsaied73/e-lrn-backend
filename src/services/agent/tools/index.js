'use strict';

/**
 * tools/index.js â€” the agent tool registry (Phase 1).
 *
 * Why a registry of plain definitions instead of exporting LangChain tools:
 *  - Phase 1 must not depend on any LLM SDK. The repo lazy-requires LangChain
 *    everywhere (see src/services/aiGrader/provider.js) and this keeps that
 *    property: the SDK is only touched inside toLangChainTools().
 *  - Definitions carry metadata the graph needs and LangChain objects hide:
 *    kind (read/action), requiresApproval, audit spec, cache TTL.
 *  - Validation runs at LOAD time. A duplicate name, a missing Arabic
 *    description, or a mutation without an audit spec throws here â€” at boot â€”
 *    instead of surfacing as a wrong number in front of an admin.
 */

const config = require('../../../config/env');
const { KIND_READ, KIND_ACTION, execute } = require('./_kit');

// The selection lexicon and the token helpers come from the router rather than from a
// hand-written keyword table: the router already maps every INTENT to its tool and
// already owns Arabic normalization + clitic tolerance ("ÙˆØ§Ù„Ø·Ù„Ø§Ø¨" â†’ "Ø§Ù„Ø·Ù„Ø§Ø¨"). Reusing
// it means the tool surface can never drift from the fast path, and adding a tool means
// adding an intent, not editing a second list that nobody remembers to update.
const { INTENTS, normalize, tokenize, containsSequence, tokenMatches, phraseTokens, route } = require('../router');
const { wrapReadDefinition } = require('../toolCache');

// z is needed for toJSONSchema in stripUnsupportedSchemaKeys(). The tool files
// own their own schemas; this is only the serialiser the provider is shown.
const { z } = require('zod');

const readDefinitions = [
  ...require('./platform'),
  ...require('./students'),
  ...require('./courses'),
  ...require('./quizzes'),
  ...require('./enrollments'),
  ...require('./operations'),
  // Schema/metadata reads. Last in the list on purpose: they answer a question no
  // other tool can ("which TABLES does this platform have?"), so nothing that
  // already worked depends on them, and their 3 schemas are only bound when the
  // question is about the database.
  ...require('./schema'),
];

// Action definitions are LOADED but only exposed when the mutation switch is on
// (config.aiAgent.allowMutations, default false â€” see resolveAiAgent). The
// approval gate inside execute() is a second, independent guard.
const actionDefinitions = [...require('./actions')];

const NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;
const ARABIC_RE = /[\u0600-\u06FF]/;

function validate(defs, seen) {
  for (const def of defs) {
    const where = `tool "${def && def.name}"`;
    if (!def || typeof def !== 'object') throw new Error('[agent/tools] definition is not an object');
    if (!NAME_RE.test(def.name || '')) throw new Error(`[agent/tools] ${where}: name must be snake_case (a-z0-9_)`);
    if (seen.has(def.name)) throw new Error(`[agent/tools] duplicate tool name "${def.name}"`);
    seen.add(def.name);

    if (typeof def.description !== 'string' || def.description.trim().length < 20) {
      throw new Error(`[agent/tools] ${where}: description is required and must be explanatory`);
    }
    // Arabic-only doctrine, enforced mechanically rather than by convention.
    if (!ARABIC_RE.test(def.description)) throw new Error(`[agent/tools] ${where}: description must be in Arabic`);
    if (!def.schema || typeof def.schema.safeParse !== 'function') {
      throw new Error(`[agent/tools] ${where}: schema must be a Zod object`);
    }
    if (typeof def.run !== 'function') throw new Error(`[agent/tools] ${where}: run must be a function`);

    if (def.kind === KIND_ACTION) {
      if (def.requiresApproval !== true) throw new Error(`[agent/tools] ${where}: actions require approval`);
      if (!def.audit || typeof def.audit.action !== 'string') {
        throw new Error(`[agent/tools] ${where}: actions must declare an audit action`);
      }
      if (def.cacheTtlSeconds !== 0) throw new Error(`[agent/tools] ${where}: actions must never be cached`);
    } else if (def.kind === KIND_READ) {
      if (!Number.isSafeInteger(def.cacheTtlSeconds) || def.cacheTtlSeconds < 0) {
        throw new Error(`[agent/tools] ${where}: cacheTtlSeconds must be a non-negative integer`);
      }
    } else {
      throw new Error(`[agent/tools] ${where}: unknown kind "${def.kind}"`);
    }
  }
}

const seenNames = new Set();
validate(readDefinitions, seenNames);
validate(actionDefinitions, seenNames);

/** Tools visible to the model: read-only unless mutations are explicitly armed. */
function listDefinitions({ includeActions = Boolean(config.aiAgent.allowMutations) } = {}) {
  return includeActions ? [...readDefinitions, ...actionDefinitions] : [...readDefinitions];
}

function getDefinition(name) {
  return readDefinitions.find((d) => d.name === name) || actionDefinitions.find((d) => d.name === name) || null;
}

// â”€â”€â”€ Phase 4.5: per-question tool-surface selection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// WHY THIS EXISTS (measured, not guessed): binding all 28 read tools ships ~25.8k
// characters â€” about 7,000 tokens â€” of JSON schema on EVERY model call, and this
// deployment's Groq free tier allows 8,000 tokens per MINUTE. A two-call turn
// therefore could not fit through the door no matter which model id was used: the
// tier was structurally dead, and the "fix the model id" work alone would not have
// saved it. The model does not need 28 schemas to answer "ÙƒÙ… Ø¹Ø¯Ø¯ Ø§Ù„Ø·Ù„Ø§Ø¨ ÙÙŠ Ø§Ù„ØµÙ
// Ø§Ù„Ø«Ø§Ù„Ø«ØŸ" â€” it needs the two or three that can answer it.
//
// The selection is DETERMINISTIC and costs no I/O: a core set, plus the tools the
// router already maps to this question, plus whatever this conversation has already
// used. Nothing here calls a model, so trimming the schema cannot make a turn
// slower to start.

/** Always offered: these answer the questions that carry no specific keyword. */
const CORE_TOOL_NAMES = ['platform_overview', 'students_count_by_grade', 'revenue_summary'];

/**
 * Hard ceiling on READ tools per turn. Chosen from the measurement above: 8 tools
 * is roughly 2k tokens of schema, which leaves real room inside an 8k TPM for the
 * question, the system prompt and the tool RESULTS (the results are what actually
 * blow the budget once a row-returning tool answers).
 */
const MAX_READ_TOOLS_PER_TURN = 8;

/**
 * tool -> the phrases that select it, derived from the ROUTER's intents (never from
 * a hand-written second list: see the require comment at the top of this file).
 * Normalized ONCE at load, because this runs on every turn and normalization is the
 * expensive half.
 */
const TOOL_LEXICON = (() => {
  const phrasesByTool = new Map();
  for (const intent of INTENTS) {
    if (!intent || !intent.tool) continue;
    const phrases = phrasesByTool.get(intent.tool) || new Set();
    for (const phrase of intent.phrases || []) phrases.add(phrase);
    phrasesByTool.set(intent.tool, phrases);
  }
  const lexicon = new Map();
  for (const [tool, phrases] of phrasesByTool) {
    const tokens = [...phrases].map((p) => phraseTokens(p)).filter((t) => t.length);
    if (tokens.length) lexicon.set(tool, tokens);
  }
  return lexicon;
})();

/**
 * Arabic function words carry no topical signal but appear in nearly every Arabic
 * sentence, so they are dropped before any matching. Small on purpose: a word is
 * only removed here when it is almost always grammar, never when it can be content.
 */
const STOPWORDS = new Set([
  'Ù…Ù†', 'ÙÙŠ', 'Ø¹Ù„Ù‰', 'Ø§Ù„Ù‰', 'Ø¹Ù†', 'Ù…Ø¹', 'Ù‡Ø°Ø§', 'Ù‡Ø°Ù‡', 'Ø°Ù„Ùƒ', 'ØªÙ„Ùƒ', 'Ø§Ù„ØªÙŠ', 'Ø§Ù„Ø°ÙŠ', 'Ù…Ø§', 'Ù…Ø§Ø°Ø§',
  'ÙƒÙŠÙ', 'ÙƒÙ…', 'ÙŠÙˆØ¬Ø¯', 'Ù‡Ù„', 'Ø§Ùˆ', 'Ø«Ù…', 'ÙƒÙ„', 'Ø¨Ø¹Ø¶', 'ØºÙŠØ±', 'Ù‚Ø¯', 'ÙƒØ§Ù†', 'Ù„Ù…', 'Ù„Ø§', 'Ø§Ù†',
  'Ø§Ù†Ø§', 'Ù†Ø­Ù†', 'Ù‡Ùˆ', 'Ù‡ÙŠ', 'Ù‡Ù…', 'Ø¨ÙŠÙ†', 'Ù‚Ø¨Ù„', 'Ø¨Ø¹Ø¯', 'Ø®Ù„Ø§Ù„', 'Ø­ÙˆÙ„', 'Ø¹Ù†Ø¯', 'Ø§ÙŠ', 'Ø§ÙŠØ¶Ø§',
  'ÙŠØ¹ÙŠØ¯', 'ØªØ¹ÙŠØ¯', 'Ø§Ù„Ø§Ø¯Ø§Ù‡', 'Ø§Ø¯Ø§Ù‡', 'ÙØ±Ø²', 'Ù…Ø±ØªØ¨', 'Ø­Ø³Ø¨', 'Ø§Ù„Ø§Ø®ÙŠØ±', 'Ø§ÙŠØ§Ù…', 'ÙŠÙˆÙ…', 'Ø§Ù„ÙØªØ±Ø©',
]);

/**
 * The SECOND half of the lexicon, and the half that actually matters.
 *
 * The router's phrases are deliberately CONSERVATIVE â€” they decline anything not
 * confidently matched, because on the fast path a wrong guess is worse than no
 * answer. That makes them the wrong basis for tool selection: every question that
 * reaches the LLM tier is, by construction, one the router DECLINED, so routing on
 * the same phrases left the model with the core set only (measured: "Ù…ØªÙˆØ³Ø· Ø¯Ø±Ø¬Ø§Øª
 * Ø§Ù„Ø·Ù„Ø§Ø¨" and "ÙƒÙŠÙ Ø­Ø§Ù„ Ø§Ù„ÙÙŠØ¯ÙŠÙˆÙ‡Ø§Øª" selected 0 relevant tools). A model shown no
 * relevant tool answers "Ù„Ø§ ØªÙˆØ¬Ø¯ Ø£Ø¯Ø§Ø© Ù…Ù†Ø§Ø³Ø¨Ø©" â€” the trim would have worked and the
 * tier would still have been useless.
 *
 * So relevance also comes from each tool's OWN Arabic description, which is already
 * written to explain what the tool returns ("Ù…ØªÙˆØ³Ø· Ø¯Ø±Ø¬Ø§Øª Ø§Ù„Ø·Ù„Ø§Ø¨", "Ø­Ø§Ù„Ø© Ø§Ù„ÙÙŠØ¯ÙŠÙˆÙ‡Ø§Øª").
 * A description word only counts when it is DISTINCTIVE â€” it appears in at most
 * MAX_SHARED_DESCRIPTION_TOKENS tools' descriptions â€” which is what filters out the
 * vocabulary every tool shares ("Ø£Ø¯Ø§Ø©", "ÙŠØ¹ÙŠØ¯", "Ø¢Ø®Ø± N Ø£ÙŠØ§Ù…") without a stoplist
 * anyone has to maintain by hand.
 */
const MAX_SHARED_DESCRIPTION_TOKENS = 6;

// A phone-number lookup is a student_search question even when the
// wording mentions no name. Any run of 7+ ASCII digits means the admin pasted
// a phone number (Egyptian mobiles are 11 digits) — boost student_search so
// the shortlist contains the one tool that can answer it.
const PHONE_DIGITS_RE = /\d{7,}/;

/** tool -> the distinctive words of its description that a question can match. */
const TOOL_DESCRIPTION_TOKENS = (() => {
  const tokensByTool = new Map();
  const frequency = new Map();

  for (const def of readDefinitions) {
    const tokens = new Set(
      tokenize(normalize(def.description)).filter((t) => t.length > 2 && !STOPWORDS.has(t))
    );
    tokensByTool.set(def.name, tokens);
    for (const token of tokens) frequency.set(token, (frequency.get(token) || 0) + 1);
  }

  const distinctive = new Map();
  for (const [tool, tokens] of tokensByTool) {
    distinctive.set(
      tool,
      [...tokens].filter((t) => (frequency.get(t) || 0) <= MAX_SHARED_DESCRIPTION_TOKENS)
    );
  }
  return distinctive;
})();

/**
 * Pick the tool surface for ONE question.
 *
 * Sources, in the order they are trusted:
 *   core     â€” the small always-useful set.
 *   history  â€” tools this conversation already used, so a follow-up turn keeps its
 *              context ("ÙˆÙ…Ø§Ø°Ø§ Ø¹Ù† Ø§Ù„Ø¯ÙØ¹ØŸ" must still be able to call the tool the
 *              previous turn used).
 *   router   â€” the tool the deterministic fast path would have chosen.
 *   phrase   â€” every tool whose lexicon the question matches, longest match first.
 *
 * Reads are then capped at `maxReads`. Actions are NOT trimmed: a missing read tool
 * costs one clarifying turn, whereas a missing action is a workflow the model simply
 * cannot perform â€” and the mutation switch is opt-in anyway.
 *
 * Returns the definitions plus WHY each one was chosen, so a test (or an operator
 * reading a log) can tell a deliberate trim from a bug.
 */
function selectToolSet({
  question,
  historyTools = [],
  includeActions = Boolean(config.aiAgent.allowMutations),
  maxReads = MAX_READ_TOOLS_PER_TURN,
} = {}) {
  const chosen = new Map();
  const reasons = new Map();

  const add = (name, why) => {
    if (!name || chosen.has(name)) return;
    const def = getDefinition(name);
    // Only reads are subject to selection; actions are handled separately below.
    if (!def || def.kind !== KIND_READ) return;
    chosen.set(name, def);
    reasons.set(name, why);
  };

  for (const name of CORE_TOOL_NAMES) add(name, 'core');
  for (const name of historyTools) add(name, 'history');

  const tokens = tokenize(normalize(question || ''));
  if (tokens.length) {
    const match = route(question);
    if (match && match.matched && match.tool) add(match.tool, 'router');

    const questionTokens = new Set(tokens);
    const hasPhoneDigits = PHONE_DIGITS_RE.test(question || '');
    const wantsStudent =
      hasPhoneDigits ||
      [...questionTokens].some(
        (t) =>
          t === 'طالب' ||
          t === 'طلاب' ||
          t === 'الطالب' ||
          t === 'الطلاب' ||
          t === 'طالبه' ||
          t === 'رقمه' ||
          t === 'رقم' ||
          t === 'هات' ||
          t === 'هاتف'
      );
    const scored = [];
    for (const def of readDefinitions) {
      // A phrase hit is worth more than a stray word: "Ø§Ø´ØªØ±Ø§ÙƒØ§Øª Ø§Ù„Ø¯ÙˆØ±Ø§Øª" identifies a
      // tool outright, while "Ø§Ù„Ø·Ù„Ø§Ø¨" alone only suggests a family of them.
      let phraseScore = 0;
      for (const phrase of TOOL_LEXICON.get(def.name) || []) {
        if (containsSequence(tokens, phrase)) phraseScore += phrase.length;
      }
      let wordScore = 0;
      for (const token of TOOL_DESCRIPTION_TOKENS.get(def.name) || []) {
        if (questionTokens.has(token)) wordScore += 1;
      }
      const score = phraseScore * 3 + wordScore;
      if (score > 0) scored.push({ name: def.name, score });
    }
    // Longest phrase wins ("Ø§Ø´ØªØ±Ø§ÙƒØ§Øª Ø§Ù„Ø¯ÙˆØ±Ø§Øª" is a sharper signal than "Ø§Ø´ØªØ±Ø§ÙƒØ§Øª"),
    // and the name breaks ties so two equal questions always get the same surface.
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    if (wantsStudent) add('student_search', hasPhoneDigits ? 'phone-digits' : 'student-word');
    for (const hit of scored) add(hit.name, `score:${hit.score}`);
  }

  const reads = [...chosen.keys()].slice(0, maxReads).map((name) => chosen.get(name));
  const actions = includeActions ? [...actionDefinitions] : [];

  return { reads, actions, defs: [...reads, ...actions], reasons };
}

/** Flat form, for callers that just want definitions (the graph, tests). */
function selectDefinitions(options = {}) {
  return selectToolSet(options).defs;
}

/**
 * Approximate the schema weight of a tool set, for the measurement recorded in
 * graph.js. `/4` is the usual chars-per-token rule of thumb and is only ever used
 * for a comment and a test bound â€” never for a decision.
 */
function approximateSchemaTokens(defs) {
  const chars = defs.reduce((sum, def) => {
    const shape = {
      name: def.name,
      description: def.description,
      // Zod has no portable "describe this as JSON" without zod-to-json-schema, so
      // the field NAMES are the honest cheap proxy: the descriptions on them are
      // Arabic and dominate anyway.
      fields: Object.keys(def.schema.shape || {}),
    };
    return sum + JSON.stringify(shape).length;
  }, 0);
  return { chars, tokens: Math.round(chars / 4) };
}

// ─── P3: the intent gate for the mutating surface ─────────────────────────────
//
// WHY THIS EXISTS, with the measured cost (approximateSchemaTokens below, chars/4):
// a read-only turn binds 7-8 tools ≈ 508-636 tokens, while the SAME turn with the 12
// actions bound rises to 19-20 tools ≈ 1,333-1,461 tokens. That ~2.5-3x is paid on
// EVERY model call of EVERY turn — including "كم عدد الطلاب؟", which the read surface
// answers on its own. It is also attention dilution: 12 mutating schemas sit between
// the question and the tool that answers it, and this deployment's providers already
// answer a turn without emitting a tool call intermittently.
//
// WHY A LEXICON AND NOT A MODEL CALL: this runs BEFORE the first model call, so it has
// to be free, synchronous and deterministic. A classifier would pay the very latency
// and token cost this gate exists to save.
//
// THE BIAS IS DELIBERATE: a false positive costs schema tokens for one turn, whereas a
// false negative makes a write request unanswerable — «لا تتوفر لدي أداة مناسبة», the
// exact bug this work is fixing. Every close call below resolves to "expose the actions".
//
// Matching goes through the router's own normalize()/tokenize()/tokenMatches() (imported
// above) rather than a second Arabic matcher: a gate that disagreed with the fast path
// about what a word means would disagree silently.

/** Action tool names: a conversation that already used one keeps the action surface. */
const ACTION_NAMES = new Set(actionDefinitions.map((d) => d.name));

/** Imperatives that ask for a change and nothing else ("سجّل", "ألغِ", "رتّب"). */
const WRITE_VERBS = [
  'سجل', 'الغ', 'الغي', 'اعتمد', 'صحح', 'ارسل', 'اعط', 'انشئ', 'اضف', 'حدث',
  'احذف', 'ازل', 'فعل', 'عطل', 'علم', 'ارفع', 'استثن', 'رتب', 'اجعل', 'امنح', 'اقبل', 'اعد',
  'تضيف', 'تمسح', 'ضيف', 'امسح', 'تحذف', 'تحدث', 'تعدل', 'تغير', 'تسجل',
  'عدل', 'اضيفي', 'ضيفي', 'امسحي', 'احذفي', 'عدلي', 'حدثي', 'غيري', 'سجلي',
];

/**
 * Verbal nouns: admins write "إلغاء تسجيل" as often as "ألغِ التسجيل". "تصحيح" is
 * deliberately absent — it is the analytics collocation in "طابور التصحيح" (one of the
 * router's own questions), while the imperative "صحح" already covers a real request.
 */
const WRITE_NOUNS = [
  'تسجيل', 'الغاء', 'اعتماد', 'ارسال', 'اعطاء', 'انشاء', 'اضافه', 'تحديث', 'تعديل',
  'حذف', 'ازاله', 'تفعيل', 'تعطيل', 'رفع', 'استثناء', 'ترتيب', 'اعاده', 'منح', 'قبول',
];

/**
 * Affixes Arabic glues onto a verb: one trailing object pronoun. CLOSED list on
 * purpose — an open prefix match would read the analytics word "فعالية" as the
 * imperative "فعّل" and arm the mutation surface for a question that only counts things.
 */
const WRITE_SUFFIXES = ['', 'ه', 'ها', 'هم', 'هن', 'ك', 'كم', 'نا', 'ني', 'ت', 'وا'];

/**
 * Enabling phrases. They are a request for PERMISSION, so on their own they decide
 * nothing: "هل يمكن تسجيل الطالب أحمد؟" is a write, "هل يمكن معرفة عدد الطلاب؟" is a read.
 */
const WRITE_ENABLERS = [
  'هل يمكن', 'هل يمكنك', 'هل تستطيع', 'ممكن', 'اريد', 'ارجو', 'من فضلك', 'لو سمحت',
  'عايز', 'ياريت', 'برجاء',
];

/**
 * The one entry Arabic spelling makes undecidable: "غيّر" (change it) and "غير"
 * (not / other) normalize to the SAME token, and "غير" is also the analytics word in
 * "الطلاب غير النشطين". It is therefore position-sensitive; see hasWriteIntent.
 */
const AMBIGUOUS_WRITE_TOKEN = 'غير';

/** One lexicon entry against one token, tolerating a clitic and one pronoun suffix. */
function isWriteToken(token, entry) {
  return WRITE_SUFFIXES.some((suffix) => {
    if (suffix && !token.endsWith(suffix)) return false;
    const stem = suffix ? token.slice(0, -suffix.length) : token;
    // tokenMatches (not ===) so "والغ" and "الغ" are the same word to this gate too.
    return Boolean(stem) && tokenMatches(stem, entry);
  });
}

/**
 * Does this turn LOOK like a write request? Pure: no config, no I/O, no clock — the
 * caller owns the mutation switch, because this helper only answers "is the admin
 * asking for a change?".
 *
 * `historyTools` is the tool names this conversation already used. An ACTION name in it
 * forces true, for the same reason selectToolSet keeps history tools: a follow-up
 * ("وما حالة الطلب؟") carries no imperative, and dropping the action surface mid-thread
 * would strand the admin exactly where the previous turn left off.
 */
function hasWriteIntent(question, historyTools = []) {
  if (Array.isArray(historyTools) && historyTools.some((name) => ACTION_NAMES.has(name))) return true;

  const tokens = tokenize(normalize(question || ''));
  if (!tokens.length) return false;

  const verbHit = tokens.some((token) => WRITE_VERBS.some((entry) => isWriteToken(token, entry)));
  const nounHit = tokens.some((token) => WRITE_NOUNS.some((entry) => isWriteToken(token, entry)));
  const enabled = WRITE_ENABLERS.some((phrase) => containsSequence(tokens, phraseTokens(phrase)));

  // The ambiguous form only counts where an imperative can grammatically sit: as the
  // FIRST token of the request ("غيّر سعر الدورة"), or anywhere once an enabling phrase
  // is present ("هل يمكن تغيير..."). Mid-sentence it is the negation in "غير النشطين".
  const changeHit = tokens.some((token) => isWriteToken(token, AMBIGUOUS_WRITE_TOKEN));
  const leadingChange = changeHit && isWriteToken(tokens[0], AMBIGUOUS_WRITE_TOKEN);

  if (enabled) return verbHit || nounHit || changeHit;
  return verbHit || nounHit || leadingChange;
}

/**
 * Strip JSON-Schema keywords Gemini rejects, without touching the Zod schema the
 * tool actually validates with.
 *
 * WHY THIS EXISTS: the generateContent API accepts only a small subset of JSON
 * Schema and rejects the WHOLE request — 400, every tool, every turn — on the
 * first keyword it does not know. Found live, one at a time:
 *   exclusiveMinimum  ← z.number().int().positive()  (Zod 4 default target)
 *   propertyNames     ← z.record() / z.object().catchall()
 *   const / examples  ← z.literal(), z.enum()'s examples
 * That last one matters most: a single tool in a 15-tool payload carrying one bad
 * keyword made the agent answer "تعذّر الوصول إلى مزوّد الذكاء الاصطناعي" to
 * EVERY question. Groq tolerates all of it, which is why this stayed invisible
 * while Groq was primary — the two vendors disagree about the dialect, not about
 * the tools.
 *
 * This is a WHITELIST for the same reason: enumerating the rejected keywords
 * means the next Zod release that emits something new breaks the agent silently
 * again, and the failure looks like a provider outage rather than a schema bug.
 *
 * `exclusiveMinimum: 0` becomes `minimum: 1`: every id here is a 1-based
 * autoincrement key, so the stricter bound is the honest one. Anything dropped
 * only narrows what the model is TOLD; execute() still validates with the tool's
 * own Zod schema, so a bad argument is rejected exactly as before. This stops
 * the provider refusing to look at the tools — it does not weaken the tools.
 */
const GEMINI_SCHEMA_KEYS = new Set([
  'type', 'format', 'title', 'description', 'default',
  'enum', 'items', 'properties', 'required', 'additionalProperties',
  'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength',
  'pattern', 'nullable',
]);

function stripUnsupportedSchemaKeys(schema) {
  const convert = (node) => {
    if (Array.isArray(node)) return node.map(convert);
    if (!node || typeof node !== 'object') return node;

    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'exclusiveMinimum') {
        if (typeof value === 'number') out.minimum = value + 1;
        continue;
      }
      if (key === 'exclusiveMaximum') {
        if (typeof value === 'number') out.maximum = value - 1;
        continue;
      }
      if (!GEMINI_SCHEMA_KEYS.has(key)) continue;

      // `properties` is a MAP OF NAMES, not a schema node: its keys are argument
      // names (attemptId, courseSlug, …) and every one of them must survive. The
      // generic branch would whitelist-filter those names away and produce
      // `properties: {}` — a tool that declares three arguments and tells the model
      // it takes none. So the map is passed through by key and only its VALUES are
      // converted.
      if (key === 'properties') {
        const map = {};
        for (const [name, sub] of Object.entries(value || {})) {
          map[name] = convert(sub);
        }
        out.properties = map;
        continue;
      }

      // additionalProperties: false is how Zod says "reject unknown keys"; Gemini
      // only understands the boolean, and a schema object here is not supported.
      if (key === 'additionalProperties' && typeof value !== 'boolean') {
        out.additionalProperties = false;
        continue;
      }
      out[key] = convert(value);
    }
    return out;
  };

  /**
   * Cross-check: Gemini requires every name in `required` to exist in
   * `properties`. Zod can emit a `required` entry for an optional key under some
   * unions/refinements, and Gemini answers 400 "property is not defined" for the
   * WHOLE payload — so the two lists are reconciled here rather than trusted.
   */
  const pruneRequired = (node) => {
    if (Array.isArray(node)) {
      node.forEach(pruneRequired);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (node.properties) {
      node.required = Array.isArray(node.required)
        ? node.required.filter((name) => Object.prototype.hasOwnProperty.call(node.properties, name))
        : [];
      if (node.required.length === 0) delete node.required;
    }
    if (node.items) pruneRequired(node.items);
  };

  try {
    const json = z.toJSONSchema(schema, { io: 'input' });
    // Gemini rejects a parameterless object schema outright ("parameters" with no
    // properties), and it must still be an object-typed schema either way.
    if (!json.properties) json.properties = {};
    const converted = convert(json);
    pruneRequired(converted);

    // Positive control, enforced in CODE rather than only in a test: a strip that
    // silently emptied `properties` would leave a schema that is valid, leak-free
    // and completely useless — the model would be told the tool takes no arguments.
    // Zod's `$schema`/title keys are dropped by the whitelist, so anything still
    // here came from the real schema.
    if (!converted.properties || Object.keys(converted.properties).length === 0) {
      // A parameterless tool is legitimate only if the source said so.
      if (json.properties && Object.keys(json.properties).length > 0) {
        throw new Error(`stripUnsupportedSchemaKeys erased the arguments of a ${Object.keys(json.properties).length}-argument schema`);
      }
    }
    return converted;
  } catch (err) {
    // A schema Zod cannot express, or one this strip would damage, falls back to
    // the Zod form. The vendor then reports the real problem instead of the model
    // being handed an empty tool — a loud failure beats a silently useless one.
    if (err && /erased the arguments/.test(String(err.message))) throw err;
    return schema;
  }
}

/**
 * Convert definitions to LangChain tools. `resolveContext(args, def)` supplies the
 * per-invocation context (at minimum { approved, adminId } for actions) â€” the
 * graph passes the approval it just received, which is exactly why the approval
 * gate cannot be bypassed by the model: it is not part of the tool's arguments.
 *
 * `def` is passed as the second argument so a resolver can bind a decision to a
 * SPECIFIC tool (an approval for one action must not authorise another).
 */
function toLangChainTools(defs = listDefinitions(), resolveContext = () => ({})) {
  const { tool } = require('@langchain/core/tools');
  return defs.map((def) => {
    // `await` on purpose: an authority check may need to hit the database (consuming
    // a single-use approval), and a sync-only resolver would force that check to
    // happen somewhere less safe. A non-promise return is awaited harmlessly.
    //
    // Phase 4.5: the per-process micro-cache is installed on the MODEL-FACING copy
    // only. A direct execute(def, â€¦) caller (the tool unit tests, the DB suites)
    // keeps reaching the database, so an assertion about real query counts stays
    // meaningful instead of being satisfied by a cache nobody expected.
    const bound = def.kind === KIND_READ ? wrapReadDefinition(def) : def;
    return tool(async (args) => execute(bound, args, await resolveContext(args, def)), {
      name: def.name,
      description: def.description,
      // The MODEL is shown a plain JSON Schema with the keywords Gemini rejects
      // removed (see stripUnsupportedSchemaKeys). execute() below still validates
      // with the tool's own Zod schema, so this is a transport fix only.
      schema: stripUnsupportedSchemaKeys(def.schema),
    });
  });
}

module.exports = {
  readDefinitions,
  actionDefinitions,
  listDefinitions,
  getDefinition,
  toLangChainTools,
  toolNames: () => listDefinitions({ includeActions: true }).map((d) => d.name),
  // Phase 4.5 â€” the per-question tool surface.
  selectToolSet,
  selectDefinitions,
  approximateSchemaTokens,
  // P3 — the write-intent gate the graph consults before it binds the action tools.
  hasWriteIntent,
  TOOL_LEXICON,
  TOOL_DESCRIPTION_TOKENS,
  CORE_TOOL_NAMES,
  MAX_READ_TOOLS_PER_TURN,
  MAX_SHARED_DESCRIPTION_TOKENS,
};
