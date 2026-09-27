'use strict';
/* Agent write-intent gate for the mutating tool surface (P3) — pure: no DB, no Redis,
 * no network, no model.
 *
 * WHY THIS FILE EXISTS: the action catalogue is 12 tools and, measured on the
 * model-facing schema (name + description + argument names, chars/4), it roughly triples
 * the surface: 7-8 reads ≈ 508-636 tokens vs the same turn armed ≈ 1,333-1,461 tokens —
 * paid on every model call of every turn. So the graph now binds the actions only for a
 * turn that LOOKS like a write. That gate is a heuristic, and a heuristic that silently
 * stops arming the actions looks EXACTLY like the reported bug (the agent answering
 * «لا تتوفر لدي أداة مناسبة» to «سجّل الطالب …»): nothing else in the suite would go red.
 * These cases pin both directions, the honest middle (an enabling phrase is a request,
 * not a write), conversation continuity, and the untouched selection contract.
 *
 * Run: node --test tests/agent-actions-intent.test.js
 */
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  readDefinitions,
  actionDefinitions,
  selectToolSet,
  approximateSchemaTokens,
  hasWriteIntent,
} = require('../src/services/agent/tools');
const envConfig = require('../src/config/env');

/**
 * Where a case touches the mutation switch it PINS it instead of inheriting it: a
 * developer .env with AI_AGENT_ALLOW_MUTATIONS=true must not decide what this file proves.
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

before(() => {
  restoreMutations = pinMutations(false);
});

afterEach(() => {
  restoreMutations();
  restoreMutations = pinMutations(false);
});

after(() => {
  restoreMutations();
});

const WRITE_QUESTIONS = [
  'سجّل الطالب في دورة الفيزياء',
  'ألغِ تسجيل الطالب أحمد',
  'أرسل إشعاراً لكل الطلاب',
  'اعتمد الاشتراك',
  'رتّب الفيديوهات',
  'غيّر سعر الدورة',
  'احذف الفيديو الأول',
  'علّم الفيديو كفشل',
  'صحح مقال الطالب',
  'استثنِ الطالب من بوابات الاختبار',
  'فعّل اشتراك الطالب',
  'حدّث بيانات الطالب',
  'أضف طالباً إلى الدورة',
];

/**
 * Deliberately includes the contract suite's own analytics questions ("الطلاب غير
 * النشطين", "طابور التصحيح"): a false positive there would pay for the mutation menu on a
 * counting question, which is the cost this gate exists to remove.
 */
const READ_QUESTIONS = [
  'كم عدد الطلاب؟',
  'ما هو متوسط درجات الطلاب؟',
  'حالة الفيديوهات',
  'اشتراكات الدورات',
  'الطلاب غير النشطين',
  'طابور التصحيح',
  'مرحبا',
  'نظرة عامة',
  '',
];

describe('agent write-intent gate (P3)', () => {
  it('reads an imperative as a write request', () => {
    for (const question of WRITE_QUESTIONS) {
      assert.equal(hasWriteIntent(question), true, `expected write intent for «${question}»`);
    }
  });

  it('does not arm the mutation surface for a counting or greeting question', () => {
    for (const question of READ_QUESTIONS) {
      assert.equal(hasWriteIntent(question), false, `«${question}» must stay read-only`);
    }
  });

  /**
   * An enabling phrase is a request for permission, so it must not decide on its own:
   * "هل يمكن تسجيل الطالب أحمد؟" asks for a write, "هل يمكن معرفة عدد الطلاب؟" asks for a
   * number. Getting this wrong in the permissive direction re-arms the surface for every
   * polite analytics question.
   */
  it('treats an enabling phrase as a write only when a write term follows it', () => {
    assert.equal(hasWriteIntent('هل يمكن تسجيل الطالب أحمد؟'), true);
    assert.equal(hasWriteIntent('هل يمكن إلغاء التسجيل؟'), true);
    assert.equal(hasWriteIntent('أريد تعديل بيانات الطالب'), true);
    assert.equal(hasWriteIntent('هل يمكن معرفة عدد الطلاب؟'), false);
    assert.equal(hasWriteIntent('من فضلك اعرض لي الإيرادات'), false);
    assert.equal(hasWriteIntent('عايز صورة عن اشتراكات الدورات'), false);
  });

  /**
   * 'غير' is the one undecidable token — غيّر (change it) and غير (not / other) normalize
   * to the same word — so it is position-sensitive: leading it is an imperative ("غيّر سعر
   * الدورة"), mid-sentence it is the filter in a real analytics question ("الطلاب غير
   * النشطين"). Both directions are pinned because only one of them is a bug.
   */
  it('separates a leading "غير" from the analytics filter', () => {
    assert.equal(hasWriteIntent('غيّر سعر الدورة'), true);
    assert.equal(hasWriteIntent('الطلاب غير النشطين'), false);
    assert.equal(hasWriteIntent('كم طالباً غير نشط؟'), false);
  });

  it('keeps the actions for a follow-up in a conversation that already called one', () => {
    const actionName = actionDefinitions[0].name;
    assert.equal(
      hasWriteIntent('وماذا عن ذلك؟', [actionName]),
      true,
      'an action already used must keep the action surface'
    );
    // ...but a READ tool in history must not arm anything: history is continuity, not intent.
    assert.equal(hasWriteIntent('وماذا عن ذلك؟', ['video_engagement']), false);
  });

  it('is independent of the mutation switch (the caller owns that decision)', () => {
    const baseline = hasWriteIntent('سجّل الطالب في الدورة');
    const restore = pinMutations(true);
    try {
      assert.equal(hasWriteIntent('سجّل الطالب في الدورة'), baseline);
      assert.equal(hasWriteIntent('كم عدد الطلاب؟'), false);
    } finally {
      restore();
    }
  });

  /**
   * The whole point of the gate, expressed the way the graph uses it: pass
   * hasWriteIntent(...) as includeActions. The read surface must be IDENTICAL either way
   * (the gate is about the actions), and only the write turn may pay for the catalogue.
   */
  it('arms the actions for a write turn and leaves an analytics turn reads-only', () => {
    const analytics = 'كم عدد الطلاب؟';
    const write = 'سجّل الطالب في دورة الفيزياء';

    const readsOnly = selectToolSet({ question: analytics, includeActions: hasWriteIntent(analytics) });
    assert.equal(readsOnly.actions.length, 0, 'an analytics turn must not ship the action catalogue');
    assert.deepEqual(
      readsOnly.defs.map((d) => d.name),
      selectToolSet({ question: analytics, includeActions: false }).defs.map((d) => d.name),
      'the gate must not change WHICH reads are selected'
    );

    const armed = selectToolSet({ question: write, includeActions: hasWriteIntent(write) });
    assert.equal(armed.actions.length, actionDefinitions.length, 'a write turn must ship the whole action catalogue');
    assert.equal(armed.defs.length, armed.reads.length + actionDefinitions.length);

    // The measured reason the gate exists. ~2.5-3x on the current catalogue; asserted as
    // "more than double" so a legitimately bigger catalogue cannot fail this.
    const readTokens = approximateSchemaTokens(readsOnly.defs);
    const armedTokens = approximateSchemaTokens(armed.defs);
    assert.ok(
      armedTokens.tokens > readTokens.tokens * 2,
      `the action catalogue must be the expensive half, saw ${readTokens.tokens} vs ${armedTokens.tokens} tokens`
    );
    console.log(
      `      [intent gate] «${analytics}» ${readsOnly.defs.length} tools ${readTokens.chars} chars (~${readTokens.tokens} tokens) | ` +
        `«${write}» ${armed.defs.length} tools ${armedTokens.chars} chars (~${armedTokens.tokens} tokens)`
    );
  });

  it('leaves the read-only default of the selector untouched', () => {
    // The contract file pins this too; repeated here because THIS change is the one that
    // could plausibly have made the actions unconditional.
    for (const question of [...READ_QUESTIONS, ...WRITE_QUESTIONS]) {
      const { actions } = selectToolSet({ question });
      assert.equal(actions.length, 0, `the default surface must stay read-only for «${question}»`);
    }
    assert.equal(
      readDefinitions.length,
      new Set(readDefinitions.map((d) => d.name)).size,
      'the read catalogue must not have grown a duplicate'
    );
    const all = selectToolSet({ question: 'اشتراكات الدورات', includeActions: true });
    assert.equal(all.actions.length, actionDefinitions.length, 'the explicit opt-in must still arm everything');
  });
});
