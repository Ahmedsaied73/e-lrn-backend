'use strict';

/**
 * Phase 2 — the deterministic ROUTER (pure: no DB, no Redis, no clock).
 *
 * The most valuable assertion here is the catalogue replay: every question the
 * catalogue claims to answer is routed, checked against the tool's STRICT Zod
 * schema, and required to land on the intent that owns it. That makes the
 * catalogue executable documentation — if someone tightens a tool's schema or
 * renames an argument, this suite fails instead of the answer silently changing.
 */

process.env.REDIS_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

const { route, INTENTS, normalize, extractSlots } = require('../src/services/agent/router');
const { getDefinition } = require('../src/services/agent/tools');

test('every catalogued sample routes to the intent that owns it, with schema-valid args', () => {
  const failures = [];
  let checked = 0;

  for (const intent of INTENTS) {
    for (const question of intent.samples) {
      checked += 1;
      const result = route(question);
      if (!result.matched) {
        failures.push(`"${question}" (${intent.id}) -> ${result.reason} ${JSON.stringify(result.candidates)}`);
        continue;
      }
      if (result.id !== intent.id) {
        failures.push(`"${question}" expected ${intent.id} but got ${result.id}`);
        continue;
      }
      const def = getDefinition(result.tool);
      assert.ok(def, `intent ${intent.id} points at unknown tool ${result.tool}`);
      const parsed = def.schema.strict().safeParse(result.args);
      if (!parsed.success) {
        failures.push(
          `"${question}" produced invalid args for ${def.name}: ${JSON.stringify(parsed.error.issues)}`
        );
      }
    }
  }

  assert.ok(checked >= 40, `expected a substantial catalogue, only ${checked} samples ran`);
  assert.deepEqual(failures, [], `routing failures:\n${failures.join('\n')}`);
});

test('the catalogue covers every read tool except the free-text search tool', () => {
  const covered = new Set(INTENTS.map((i) => i.tool));
  const { readDefinitions } = require('../src/services/agent/tools');
  const uncovered = readDefinitions.map((d) => d.name).filter((name) => !covered.has(name));
  // student_search needs a free-text term (a person's name), which cannot be
  // parsed reliably without a model — it belongs to the agentic tier on purpose.
  assert.deepEqual(uncovered, ['student_search']);
});

test('slots are extracted from real phrasings', () => {
  const cases = [
    ['كم طالب مسجل في آخر 30 يوم', { windowDays: 30 }],
    ['طلاب أولى ثانوي', { grade: 'FIRST_SECONDARY' }],
    ['طلاب تانية ثانوي', { grade: 'SECOND_SECONDARY' }],
    ['طلاب تالتة ثانوي', { grade: 'THIRD_SECONDARY' }],
    ['أعلى 5 طلاب', { take: 5 }],
    ['أفضل 10 طلاب', { take: 10 }],
    ['الطلاب الجدد آخر 6 أسابيع', { trend: { granularity: 'week', periods: 6 } }],
    ['اتجاه الاشتراكات آخر 3 شهور', { trend: { granularity: 'month', periods: 3 } }],
    ['محاولات مسلمة', { status: 'SUBMITTED' }],
    ['محاولات مصححة', { status: 'GRADED' }],
    ['منقطع من 30 يوم', { inactiveDays: 30 }],
    ['فيديوهات عالقة من 60 دقيقة', { staleMinutes: 60 }],
    ['ملف الطالب gedfufdhiish', { slug: 'gedfufdhiish' }],
  ];
  for (const [question, expected] of cases) {
    const slots = extractSlots(normalize(question));
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(slots[key], value, `"${question}" -> ${key}`);
    }
  }
});

test('the router never invents a window it was not given', () => {
  // "عدد الطلاب" is not "عدد الطلاب في آخر 30 يوماً": a missing window must stay
  // missing so the tool's own documented default applies.
  assert.equal(extractSlots(normalize('عدد الطلاب')).windowDays, null);
  assert.deepEqual(route('عدد الطلاب').args, {});
  assert.deepEqual(route('قائمة الدورات').args, {});
});

test('slugs and grades become exactly the arguments the tools declare', () => {
  assert.deepEqual(route('تفاصيل الكورس k8ity07q25xc').args, { courseSlug: 'k8ity07q25xc' });
  assert.deepEqual(route('ملف الطالب gedfufdhiish').args, { userSlug: 'gedfufdhiish' });
  assert.deepEqual(route('اشتراكات أولى ثانوي').args, { grade: 'FIRST_SECONDARY' });
  assert.deepEqual(route('الاشتراكات آخر 30 يوم').args, { windowDays: 30 });
});

test('a slug is only used as a course slug when a course is actually mentioned', () => {
  // Otherwise a student slug pasted next to "الفيديوهات" would silently filter
  // video analytics by a course that does not exist.
  const withCourse = route('تفاعل الفيديوهات في الكورس k8ity07q25xc');
  assert.equal(withCourse.args.courseSlug, 'k8ity07q25xc');
  const withoutCourse = route('تفاعل الفيديوهات gedfufdhiish');
  assert.equal(withoutCourse.args.courseSlug, undefined);
});

test('declines instead of guessing: empty, unknown and ambiguous questions', () => {
  assert.equal(route('').reason, 'EMPTY');
  assert.equal(route('    ').reason, 'EMPTY');
  assert.equal(route(null).reason, 'EMPTY');

  const unknown = route('اعمل تقرير مفصل عن كل حاجة في المنصة');
  assert.equal(unknown.matched, false);
  assert.equal(unknown.reason, 'NO_INTENT');

  // "أحدث النشاط الإداري" reads equally as "recent platform activity" and
  // "recent admin audit" — an LLM must decide, not a coin flip.
  const ambiguous = route('احدث النشاط الاداري');
  assert.equal(ambiguous.matched, false);
  assert.equal(ambiguous.reason, 'AMBIGUOUS');
  assert.deepEqual(ambiguous.candidates.sort(), ['admin_audit_recent', 'platform_recent_activity']);
});

test('a profile question without a slug declines with the missing slot named', () => {
  const result = route('ملف الطالب');
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'MISSING_SLOT_SLUG');
  assert.deepEqual(result.candidates, ['student_profile']);
});

test('normalization unifies Arabic variants, digits and clitics', () => {
  // Diacritics, hamza forms, ta-marbuta and Arabic-Indic digits all collapse, so
  // a fully-vocalized question and a plain one become the SAME text.
  assert.equal(normalize('إحْصَائِيَّاتُ الْمَنْصَةِ'), normalize('احصائيات المنصة'));
  assert.equal(normalize('عدد الطلاب ٢٠'), 'عدد الطلاب 20');
  assert.equal(normalize('كم  طالب؟'), 'كم طالب');
  assert.equal(normalize('دورة'), normalize('دوره'));
  assert.equal(normalize('أعلى'), 'اعلي');

  // The same question written with a clitic attached routes identically.
  assert.equal(route('ملخص للإيرادات').id, 'revenue_summary');
  assert.equal(route('ملخص الإيرادات').id, 'revenue_summary');
  assert.equal(route('والكورسات المتاحة').id, 'courses_list');
});

test('a number between two phrase words does not break matching', () => {
  // "أفضل 5 طلاب" must match the phrase "أفضل طلاب" — digits are data, not words.
  assert.equal(route('أفضل 5 طلاب').id, 'top_students');
  assert.equal(route('أفضل طلاب').id, 'top_students');
  assert.equal(route('أعلى 10 طلاب').args.take, 10);
});

test('the router is pure: identical input, identical output, no side effects', () => {
  const question = 'إحصائيات الاشتراكات آخر 30 يوم';
  const first = route(question);
  const second = route(question);
  assert.deepEqual(first, second);
  // A returned route must not be mutated by a later call.
  const snapshot = JSON.stringify(first);
  route('مشاكل الدفع');
  assert.equal(JSON.stringify(first), snapshot);
});

test('every intent declares a tool, a template and at least one sample', () => {
  for (const intent of INTENTS) {
    assert.match(intent.id, /^[a-z][a-z0-9_]*$/, `intent id ${intent.id}`);
    assert.equal(typeof intent.tool, 'string', `intent ${intent.id} tool`);
    assert.equal(typeof intent.template, 'string', `intent ${intent.id} template`);
    assert.equal(typeof intent.args, 'function', `intent ${intent.id} args`);
    assert.ok(Array.isArray(intent.phrases) && intent.phrases.length, `intent ${intent.id} phrases`);
    assert.ok(Array.isArray(intent.samples) && intent.samples.length, `intent ${intent.id} samples`);
  }
  const ids = INTENTS.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'intent ids must be unique');
});

