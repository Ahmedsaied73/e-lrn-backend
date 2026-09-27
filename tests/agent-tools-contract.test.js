'use strict';
/* Agent tool contract tests (Phase 1) — pure: no DB, no Redis, no network.
 *
 * These pin the properties that make the tool layer safe to hand to a model:
 *   1. The registry loads and self-validates (unique snake_case names, Arabic
 *      descriptions, Zod schemas, every action carrying an audit action).
 *   2. Read-only is the default: action tools exist but are NOT exposed to the
 *      model unless AI_AGENT_ALLOW_MUTATIONS is on.
 *   3. execute() validates arguments before doing anything else.
 *   4. execute() REFUSES any action without explicit, attributable approval —
 *      the guard behind the graph interrupt.
 *   5. Every payload leaving a tool is email-redacted and carries meta.
 *   6. The LangChain wrapper keeps the approval gate (it is not a bypass).
 *
 * Run: npm test
 */
const { describe, it, after, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
// Zod is needed here to read the RAW schema the tools declare, which is the
// positive control for the model-facing schema test below: stripping can only be
// proven to work if the un-stripped form is first shown to contain the keyword.
const { z } = require('zod');
const {
  readDefinitions,
  actionDefinitions,
  listDefinitions,
  getDefinition,
  toLangChainTools,
  selectToolSet,
  selectDefinitions,
  approximateSchemaTokens,
  TOOL_LEXICON,
  TOOL_DESCRIPTION_TOKENS,
  CORE_TOOL_NAMES,
  MAX_READ_TOOLS_PER_TURN,
} = require('../src/services/agent/tools');
const { execute, readTool, AgentToolError } = require('../src/services/agent/tools/_kit');
const { wrapReadDefinition, createTtlCache, clearCache, cacheStats } = require('../src/services/agent/toolCache');
const envConfig = require('../src/config/env');
const { disconnectRedis } = require('../src/integrations/redis/redisClient');

/**
 * These tests assert the DEFAULT (read-only) posture, so they PIN the flag
 * rather than inherit it. A developer .env with AI_AGENT_ALLOW_MUTATIONS=true
 * otherwise failed the whole file with "40 !== 28" — the suite was reporting the
 * developer's environment instead of the contract.
 */
function pinMutations(value) {
  const agent = envConfig.aiAgent;
  const original = agent.allowMutations;
  agent.allowMutations = value;
  return () => {
    agent.allowMutations = original;
  };
}

let restoreMutations = null;

// Safety net: if any tool under test touches the cache, close the handle so the
// runner exits instead of hanging on an unreachable Redis socket.
before(() => {
  restoreMutations = pinMutations(false);
});

afterEach(() => {
  if (restoreMutations) {
    restoreMutations();
    restoreMutations = pinMutations(false);
  }
});

after(async () => {
  if (restoreMutations) restoreMutations();
  await disconnectRedis();
});

const ARABIC_RE = /[\u0600-\u06FF]/;

/** Minimal Prisma stand-in: counts return 7, groupBy returns one status row. */
function prismaStub() {
  const count = async () => 7;
  const groupBy = async () => [{ status: 'GRADED', _count: { _all: 5 } }];
  return {
    user: { count },
    course: { count },
    enrollment: { count },
    quiz: { count },
    quizAttempt: { count, groupBy },
    bunnyVideo: { count, groupBy },
    certificate: { count },
    aiGradingJob: { count },
    submission: { count },
  };
}

describe('agent tools — registry contract', () => {
  it('exposes the full read catalogue and (loaded but unexposed) actions', () => {
    assert.ok(readDefinitions.length >= 25, `expected >= 25 read tools, got ${readDefinitions.length}`);
    // No literal action COUNT here on purpose: the exact membership is pinned by
    // "the approved mutation catalogue is exactly the approved list" below, and a
    // second copy of the number only ever produced churn (it went stale twice —
    // when the CRUD tools landed and again when the deletes did — and turned this
    // suite red for reasons that had nothing to do with the contract).
    // Default posture: read-only. A mutation switch that is off must not leak
    // mutating tools into the model's tool list.
    assert.equal(listDefinitions().length, readDefinitions.length, 'actions hidden by default');
    assert.equal(listDefinitions().some((d) => d.kind === 'action'), false, 'no action in the default list');
    // Derived from the catalogue rather than hardcoded: the exact membership is
    // pinned by the allowlist test above, so a second literal count here only
    // produced churn (it was missed when the CRUD tools landed and turned this
    // suite red for a reason that had nothing to do with the contract).
    assert.equal(
      listDefinitions({ includeActions: true }).length,
      readDefinitions.length + actionDefinitions.length,
      'all when armed'
    );
  });

  it('names are unique snake_case and every description is Arabic', () => {
    const names = new Set();
    for (const def of [...readDefinitions, ...actionDefinitions]) {
      assert.match(def.name, /^[a-z][a-z0-9_]{2,63}$/, `${def.name} must be snake_case`);
      assert.equal(names.has(def.name), false, `${def.name} duplicated`);
      names.add(def.name);
      assert.ok(ARABIC_RE.test(def.description), `${def.name} description must be Arabic`);
      assert.ok(def.description.length >= 20, `${def.name} description must be explanatory`);
      assert.equal(typeof def.schema.safeParse, 'function', `${def.name} needs a Zod schema`);
    }
  });

  it('every action declares approval + an audit action and is never cached', () => {
    for (const def of actionDefinitions) {
      assert.equal(def.kind, 'action', `${def.name} kind`);
      assert.equal(def.requiresApproval, true, `${def.name} requiresApproval`);
      assert.equal(def.cacheTtlSeconds, 0, `${def.name} must not be cached`);
      assert.match(def.audit.action, /^[A-Z][A-Z0-9_]+$/, `${def.name} audit action shape`);
    }
  });

  it('the approved mutation catalogue is exactly the approved list', () => {
    const names = actionDefinitions.map((d) => d.name).sort();
    assert.deepEqual(names, [
      'broadcast_notification',
      'create_course',
      'create_student',
      'create_video',
      'delete_course',
      'delete_quiz',
      'delete_user',
      'delete_video',
      'enroll_student',
      'grade_essay',
      'grant_gate_exemption',
      'mark_enrollment_paid',
      'mark_video_failed',
      'reorder_course_videos',
      'reset_quiz_attempt',
      'retry_ai_grading',
      'revoke_gate_exemption',
      'unenroll_student',
      'update_course',
      'update_course_price',
      'update_student',
      'upsert_quiz',
    ]);
  });
});

describe('agent tools — execute() guards', () => {
  it('rejects invalid arguments before touching anything', async () => {
    const gradeEssay = getDefinition('grade_essay');
    await assert.rejects(
      () => execute(gradeEssay, {}, { prisma: prismaStub(), approved: true, adminId: 1 }),
      (err) => err instanceof AgentToolError && err.code === 'INVALID_ARGS'
    );
  });

  it('refuses an action with no approval, and one that cannot be attributed', async () => {
    const enroll = getDefinition('enroll_student');
    // Well-formed slugs on purpose: the schema must accept them so the APPROVAL
    // gate — not argument validation — is what refuses the call.
    const args = { userSlug: 'abc123abc123', courseSlug: 'def456def456' };

    await assert.rejects(
      () => execute(enroll, args, { prisma: prismaStub() }),
      (err) => err.code === 'APPROVAL_REQUIRED',
      'unapproved action must refuse'
    );
    await assert.rejects(
      () => execute(enroll, args, { prisma: prismaStub(), approved: true }),
      (err) => err.code === 'APPROVAL_REQUIRED',
      'approval without an admin id must refuse'
    );
    await assert.rejects(
      () => execute(enroll, args, { prisma: prismaStub(), approved: true, adminId: '1' }),
      (err) => err.code === 'APPROVAL_REQUIRED',
      'a string admin id is not attributable'
    );
  });

  it('redacts emails and attaches meta to a read payload', async () => {
    const probe = readTool({
      name: '_redaction_probe',
      description: 'أداة داخلية للتحقق من حجب البريد الإلكتروني في مخرجات الأدوات',
      cacheTtlSeconds: 0,
      run: async () => ({
        rows: [{ name: 'أحمد', phoneNumber: '01001234567', email: 'ahmed@example.com' }],
        returned: 1,
        truncated: false,
      }),
    });

    const result = await execute(probe, {}, { prisma: prismaStub() });
    assert.equal(result.data.rows[0].email, 'a***@example.com', 'email masked on the way out');
    assert.equal(result.data.rows[0].name, 'أحمد', 'name allowed');
    assert.equal(result.data.rows[0].phoneNumber, '01001234567', 'phone allowed');
    assert.equal(result.meta.tool, '_redaction_probe');
    assert.equal(result.meta.cappedAt, 50, 'read tools advertise the active row cap');
    assert.ok(!Number.isNaN(Date.parse(result.meta.asOf)), 'asOf is a timestamp');
  });

  it('runs a real read tool end to end against a stub pool (no DB)', async () => {
    const overview = getDefinition('platform_overview');
    // Cache disabled for this unit check (a live Redis handle would outlive the
    // process); the caching INTENT is asserted separately below.
    assert.ok(overview.cacheTtlSeconds > 0, 'platform_overview is cached by design');
    const result = await execute({ ...overview, cacheTtlSeconds: 0 }, {}, { prisma: prismaStub() });
    assert.equal(result.data.users.students, 7, 'student count passes through');
    assert.equal(result.data.enrollments.unpaid, 0, 'paid/unpaid derived correctly');
    assert.equal(result.data.videos.byStatus.GRADED, 5, 'groupBy map built');
    assert.equal(result.meta.cappedAt, 50, 'cap advertised even for aggregates');
  });

  it('rejects an argument the tool does not declare (no silently ignored filters)', async () => {
    const overview = getDefinition('platform_overview');
    await assert.rejects(
      () => execute({ ...overview, cacheTtlSeconds: 0 }, { windowDays: 5 }, { prisma: prismaStub() }),
      (err) => err instanceof AgentToolError && err.code === 'INVALID_ARGS',
      'an undeclared argument must fail loudly instead of being stripped'
    );
  });
});
/**
 * The char cap in finalize() is the only cross-cutting rule a new tool cannot opt
 * out of, so its worst case is pinned here on a REAL catalogue tool: a payload
 * made only of scalars (the platform aggregate) has no list to shorten, and the
 * cap must therefore keep every number and say that it trimmed rather than
 * silently returning a hollow object.
 */
describe('agent tools — the payload char cap never hollows out an answer', () => {
  it('keeps every scalar of a listless payload and declares the overshoot', async () => {
    const original = envConfig.aiAgent.maxToolResultChars;
    // Below the floor on purpose: this bypasses the env clamp to prove the
    // BEHAVIOUR at a hostile setting, not to argue about the clamp (that is
    // pinned in tests/agent-tool-payload-cap.test.js). The await is inside the
    // try — execute() is async, so restoring the cap in a finally that ran first
    // would restore it before finalize() ever read it.
    envConfig.aiAgent.maxToolResultChars = 10;
    try {
      const { data } = await execute({ ...getDefinition('platform_overview'), cacheTtlSeconds: 0 }, {}, { prisma: prismaStub() });
      assert.equal(data.users.students, 7, 'a count must survive an impossible cap');
      assert.equal(data.payloadTruncated, true, 'the overshoot is declared');
      assert.ok(data.payloadChars > 10, 'payloadChars reports the real pre-trim size');
      assert.equal(data.payloadRows, null, 'a listless payload has no row count to report');
    } finally {
      envConfig.aiAgent.maxToolResultChars = original;
    }
  });
});
describe('agent tools — LangChain wrapper', () => {
  it('wraps every default tool with its own name', () => {
    const tools = toLangChainTools();
    assert.equal(tools.length, readDefinitions.length, 'wrapper honours the default posture');
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...readDefinitions.map((d) => d.name)].sort());
  });

  it('cannot be used to bypass the approval gate', async () => {
    const [enrollTool] = toLangChainTools([getDefinition('enroll_student')]);
    await assert.rejects(
      () => enrollTool.invoke({ userSlug: 'abc123abc123', courseSlug: 'def456def456' }),
      (err) => /APPROVAL_REQUIRED|requires human approval/.test(String(err.message)),
      'the wrapper must not swallow the approval refusal'
    );
  });

  it('returns null for an unknown tool name instead of throwing', () => {
    assert.equal(getDefinition('does_not_exist'), null);
  });
});

/**
 * The model-facing schema must be a JSON Schema Gemini accepts.
 *
 * Found live, one keyword at a time: Gemini 400s the WHOLE request — every tool,
 * every turn — on the first schema keyword it does not know, and the failure looks
 * like a provider outage rather than a schema bug. So
 * stripUnsupportedSchemaKeys() runs before the tools are bound to the model.
 *
 * The assertions below are a TRANSPORT contract only. execute() still validates
 * with the tool's own Zod schema, so nothing here weakens a tool.
 */
describe('agent tools — model-facing JSON Schema (Gemini transport)', () => {
  // Every keyword Gemini rejects. `const` and `examples` are included even though no
  // tool emits them today: they are in the vendor's rejection list, and a future
  // z.literal()/z.enum() must fail HERE rather than in production.
  const BANNED_KEYS = ['exclusiveMinimum', 'exclusiveMaximum', 'propertyNames', 'const', 'examples'];

  /** Every object key reachable in a schema, at every depth. */
  function collectKeys(node, found = []) {
    if (Array.isArray(node)) {
      node.forEach((item) => collectKeys(item, found));
      return found;
    }
    if (!node || typeof node !== 'object') return found;
    for (const [key, value] of Object.entries(node)) {
      found.push(key);
      collectKeys(value, found);
    }
    return found;
  }

  const allTools = () => toLangChainTools(listDefinitions({ includeActions: true }));

  it('binds EVERY tool, actions included, so the scan below covers the whole catalogue', () => {
    const defs = listDefinitions({ includeActions: true });
    const tools = allTools();
    assert.equal(tools.length, defs.length, 'one bound tool per definition');
    assert.ok(defs.some((d) => d.kind === 'action'), 'action tools must be in scope or this proves nothing');
    assert.ok(defs.length > 30, `expected the full catalogue, got ${defs.length}`);
  });

  it('leaks no keyword Gemini rejects into the bound schema of any tool', () => {
    const offenders = [];
    for (const bound of allTools()) {
      for (const key of collectKeys(bound.schema)) {
        if (BANNED_KEYS.includes(key)) offenders.push(`${bound.name}.${key}`);
      }
    }
    assert.deepEqual(offenders, [], `Gemini 400s the whole request on these: ${offenders.join(', ')}`);
  });

  it('never lists a `required` name the same schema does not define', () => {
    // Gemini answers 400 "property is not defined" for the whole payload, so a
    // required entry with no matching property is fatal to the turn.
    const offenders = [];
    const walk = (node, toolName, path) => {
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, toolName, `${path}[${i}]`));
        return;
      }
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node.required)) {
        for (const name of node.required) {
          const declared = node.properties && Object.prototype.hasOwnProperty.call(node.properties, name);
          if (!declared) offenders.push(`${toolName} ${path}.required -> ${name}`);
        }
      }
      for (const [key, value] of Object.entries(node)) walk(value, toolName, `${path}.${key}`);
    };
    for (const bound of allTools()) walk(bound.schema, bound.name, '$');
    assert.deepEqual(offenders, [], `required names with no property: ${offenders.join(', ')}`);
  });

  // POSITIVE CONTROL. Without this the three tests above pass vacuously: a schema
  // stripped down to `{"type":"object","properties":{}}` contains no banned keyword
  // and no dangling `required`, so all three would go green on a schema that tells
  // the model nothing at all. The control pins that the raw Zod schema the tools
  // declare really does contain the keywords being stripped.
  it('POSITIVE CONTROL: the raw Zod schema really does contain the banned keywords', () => {
    const raw = z.toJSONSchema(getDefinition('grade_essay').schema, { io: 'input' });
    const keys = collectKeys(raw);
    // `grade_essay.attemptId` is z.number().int().positive() -> exclusiveMinimum,
    // and its z.record() args -> propertyNames. Both are real, not synthetic.
    assert.ok(keys.includes('exclusiveMinimum'), 'the control tool must emit exclusiveMinimum before stripping');
    assert.ok(keys.includes('propertyNames'), 'the control tool must emit propertyNames before stripping');

    // And the same tool, once bound for the model, carries neither.
    const [boundEssay] = toLangChainTools([getDefinition('grade_essay')]);
    const boundKeys = collectKeys(boundEssay.schema);
    for (const banned of ['exclusiveMinimum', 'propertyNames']) {
      assert.equal(boundKeys.includes(banned), false, `${banned} must be stripped from the bound schema`);
    }
  });

  it('POSITIVE CONTROL: stripping narrows the bounds without erasing the arguments', () => {
    // The mirror image of the vacuity risk: the strip must REMOVE keywords, never
    // silently delete the declared arguments. `exclusiveMinimum: 0` is rewritten as
    // `minimum: 1` (these are 1-based autoincrement ids), not dropped.
    const [boundEssay] = toLangChainTools([getDefinition('grade_essay')]);
    const attemptId = boundEssay.schema.properties && boundEssay.schema.properties.attemptId;
    assert.ok(attemptId, `grade_essay.attemptId vanished from the bound schema: ${JSON.stringify(boundEssay.schema)}`);
    assert.equal(attemptId.type, 'integer', 'the argument type survives the strip');
    assert.equal(attemptId.minimum, 1, 'exclusiveMinimum 0 is narrowed to minimum 1');
  });
});

/**
 * Phase 4.5 — the per-question tool surface.
 *
 * These tests protect the agentic tier from being structurally dead again. That
 * failure is invisible in ordinary use: the tier answers "لا توجد أداة مناسبة" or
 * dies on a 413 and nothing in a normal unit run goes red. So the two properties
 * that actually matter are pinned here: the surface must be SMALL, and it must
 * still CONTAIN THE TOOL THE QUESTION IS ABOUT.
 */
describe('agent tools — per-question selection (Phase 4.5)', () => {
  it('never exposes an empty surface, and always the core set', () => {
    for (const question of ['', 'مرحبا', 'zzz qqq', '؟؟؟', 'كيف حال المنصة؟']) {
      const { reads, defs } = selectToolSet({ question });
      assert.ok(reads.length > 0, `an empty surface for "${question}" makes the tier useless`);
      for (const name of CORE_TOOL_NAMES) {
        assert.ok(
          defs.some((d) => d.name === name),
          `core tool ${name} missing for "${question}"`
        );
      }
    }
  });

  it('caps the read surface and hides actions unless mutations are armed', () => {
    const { reads, actions } = selectToolSet({ question: 'اشتراكات الدورات' });
    assert.ok(reads.length <= MAX_READ_TOOLS_PER_TURN, `read surface too wide: ${reads.length}`);
    assert.equal(actions.length, 0, 'read-only by default');

    const armed = selectToolSet({ question: 'اشتراكات الدورات', includeActions: true });
    assert.equal(armed.actions.length, actionDefinitions.length, 'arming mutations must expose the whole action catalogue');
    assert.equal(armed.defs.length, armed.reads.length + actionDefinitions.length);
  });

  /* REGRESSION (P0): the reported bug was the agent answering «لا تتوفر لدي أداة مناسبة…
   * يمكنك تنفيذ هذا الإجراء من خلال لوحة التحكم الإدارية» to «سجّل الطالب … في دورة …».
   * The cause was NOT the model: actions are opt-in in selectToolSet, and with the
   * switch off the surface handed to the model contained zero action tools, so it
   * answered honestly and pointed at the admin console instead.
   *
   * The assertion is deliberately generic (at least ONE action tool) rather than a
   * named one: what must never regress is that arming mutations produces a bound
   * action tool for a write question. The LangChain half matters because the graph
   * binds the selected surface — action DEFINITIONS that never become bound tools
   * are the failure mode being pinned here.
   */
  it('binds an action tool for a write question when mutations are armed', () => {
    const restore = pinMutations(true);
    try {
      const { defs } = selectToolSet({
        question: 'سجّل الطالب في دورة الفيزياء',
        includeActions: true,
      });
      const actionNames = new Set(actionDefinitions.map((d) => d.name));
      assert.ok(
        defs.some((d) => actionNames.has(d.name)),
        `a write question with mutations armed got no action tool: ${defs.map((d) => d.name).join(', ')}`
      );

      const bound = toLangChainTools(defs);
      assert.ok(
        bound.some((t) => actionNames.has(t.name)),
        'the action definitions never reached the bound tool surface'
      );
    } finally {
      restore();
    }
  });

  it('keeps the write question action-free under the read-only default', () => {
    // The inverse guard. Always binding the action catalogue would also make the
    // test above pass, while destroying the property the rest of this file — and
    // the tool layer's whole safety argument — rests on: read-only is the default.
    const restore = pinMutations(false);
    try {
      const { defs } = selectToolSet({ question: 'سجّل الطالب في دورة الفيزياء' });
      const actionNames = new Set(actionDefinitions.map((d) => d.name));
      assert.equal(
        defs.some((d) => actionNames.has(d.name)),
        false,
        'the read-only default must never carry an action tool'
      );
    } finally {
      restore();
    }
  });

  it('picks the tool the question is actually about', () => {
    const cases = [
      ['مشاكل الدفع', 'payment_issues'],
      ['حالة الفيديوهات', 'video_pipeline_status'],
      ['الطلاب غير النشطين', 'inactive_students'],
      ['طابور التصحيح', 'grading_backlog'],
      ['قائمة الدورات', 'courses_list'],
    ];
    for (const [question, expected] of cases) {
      const names = selectDefinitions({ question }).map((d) => d.name);
      assert.ok(
        names.includes(expected),
        `"${question}" should expose ${expected}, got: ${names.join(', ')}`
      );
    }
  });


  it('keeps the tools a follow-up turn already used, even when the wording matches nothing', () => {
    const names = selectDefinitions({
      question: 'وماذا عن ذلك؟',
      historyTools: ['video_engagement'],
    }).map((d) => d.name);
    assert.ok(
      names.includes('video_engagement'),
      `a follow-up must keep its context, got: ${names.join(', ')}`
    );
  });

  it('is deterministic: the same question always gets the same surface', () => {
    const first = selectDefinitions({ question: 'اشتراكات الدورات' }).map((d) => d.name);
    const second = selectDefinitions({ question: 'اشتراكات الدورات' }).map((d) => d.name);
    assert.deepEqual(first, second);
  });

  it('is SMALLER than the full catalogue — the reason this module exists', () => {
    const full = approximateSchemaTokens(readDefinitions);
    for (const question of ['اشتراكات الدورات', 'حالة الفيديوهات', 'طابور التصحيح', 'مرحبا']) {
      const trimmed = approximateSchemaTokens(selectDefinitions({ question }));
      assert.ok(
        trimmed.tokens < full.tokens * 0.5,
        `"${question}" ships ${trimmed.tokens} tokens vs ${full.tokens} for the full catalogue`
      );
    }
    const typical = approximateSchemaTokens(selectDefinitions({ question: 'اشتراكات الدورات' }));
    console.log(
      `      [tool surface] full catalogue ${full.chars} chars (~${full.tokens} tokens) -> ` +
        `per-turn ${typical.chars} chars (~${typical.tokens} tokens)`
    );
  });

  it('leaves no read tool unreachable: every tool has selectable vocabulary', () => {
    for (const def of readDefinitions) {
      const hasPhrases = (TOOL_LEXICON.get(def.name) || []).length > 0;
      const hasWords = (TOOL_DESCRIPTION_TOKENS.get(def.name) || []).length > 0;
      assert.ok(
        hasPhrases || hasWords,
        `${def.name} has no selection vocabulary — the model could never be shown it`
      );
    }
  });
});

describe('agent tool micro-cache (Phase 4.5)', () => {
  function probeDefinition({ fail = false } = {}) {
    const state = { calls: 0 };
    const def = readTool({
      name: fail ? '_microcache_failing' : '_microcache_probe',
      description: 'أداة داخلية للتحقق من التخزين المؤقت داخل العملية للاختبارات',
      cacheTtlSeconds: 30,
      run: async () => {
        state.calls += 1;
        if (fail) throw new Error('boom');
        return { calls: state.calls, rows: [], returned: 0, truncated: false };
      },
    });
    return { def, calls: () => state.calls };
  }

  it('serves a repeated read from memory instead of the database', async () => {
    const original = envConfig.redis.enabled;
    envConfig.redis.enabled = true;
    clearCache();
    try {
      const probe = probeDefinition();
      const wrapped = wrapReadDefinition(probe.def);
      const first = await wrapped.run({}, {});
      const second = await wrapped.run({}, {});
      assert.equal(probe.calls(), 1, 'the second read must not reach the database');
      assert.deepEqual(second, first, 'a cache hit must serve the same payload');
      assert.ok(cacheStats().hits >= 1, 'the hit must be counted, not silently served');
    } finally {
      envConfig.redis.enabled = original;
      clearCache();
    }
  });

  it('is a passthrough when the shared cache layer is off (dev + DB tests)', async () => {
    const original = envConfig.redis.enabled;
    envConfig.redis.enabled = false;
    clearCache();
    try {
      const probe = probeDefinition();
      const wrapped = wrapReadDefinition(probe.def);
      await wrapped.run({}, {});
      await wrapped.run({}, {});
      assert.equal(probe.calls(), 2, 'with the cache layer off every read must hit the database');
    } finally {
      envConfig.redis.enabled = original;
      clearCache();
    }
  });

  it('never caches a failure, and never wraps an action', async () => {
    const original = envConfig.redis.enabled;
    envConfig.redis.enabled = true;
    clearCache();
    try {
      const failing = probeDefinition({ fail: true });
      const wrapped = wrapReadDefinition(failing.def);
      await assert.rejects(() => wrapped.run({}, {}));
      await assert.rejects(() => wrapped.run({}, {}));
      assert.equal(failing.calls(), 2, 'a failed query must not be pinned in front of admins');

      // An action comes back byte-identical: the cache is a read-only concept.
      assert.equal(wrapReadDefinition(getDefinition('enroll_student')), getDefinition('enroll_student'));
      assert.equal(wrapReadDefinition(null), null);
    } finally {
      envConfig.redis.enabled = original;
      clearCache();
    }
  });

  it('bounds its size and honours an injected clock', () => {
    let clock = 1_000_000;
    const cache = createTtlCache({ maxEntries: 2, now: () => clock });
    cache.set('a', 1, 10);
    cache.set('b', 2, 10);
    cache.set('c', 3, 10);
    assert.equal(cache.size(), 2, 'oldest entries must be evicted, not accumulate');
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('c'), 3);
    clock += 10_001;
    assert.equal(cache.get('c'), undefined, 'an entry must expire on its own TTL');
  });
});
