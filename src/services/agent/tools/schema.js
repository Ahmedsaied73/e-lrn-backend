'use strict';

/**
 * schema.js — read-only DATABASE-SHAPE tools (the Supabase/Postgres schema).
 *
 * WHY THIS FILE EXISTS: every other tool in the catalogue answers questions about
 * DATA ("كم عدد الطلاب"). None of them could answer a question about the DATABASE
 * itself — "ما الجداول الموجودة؟", "إيه أعمدة جدول الاشتراكات؟", "الجداول دي
 * مفهرسة ولا لأ؟" — and an admin who gets a confident non-answer for those is worse
 * off than one who gets a grounded one. These three tools close that gap.
 *
 * TWO SOURCES, DELIBERATELY SEPARATED:
 *   1. `Prisma.dmmf.datamodel.models` — the SHAPE of the schema, read straight out
 *      of the generated client. It needs no database connection at all, so
 *      `db_schema_overview` still answers with the database down. This is the same
 *      22 models Prisma itself validates against, so it cannot drift from the code.
 *   2. TWO fixed catalogue queries for what only the live database knows: the REAL
 *      indexes/constraints (Prisma's DMMF cannot see a hand-written `CREATE INDEX`
 *      in a migration, and it cannot see a table's size or row estimate).
 *
 * THE SQL-SAFETY RULE (the reason this file is allowed near raw SQL at all):
 *   This catalogue is otherwise 100% Prisma, and NO tool anywhere in the agent
 *   accepts user SQL — that deliberate decision is what keeps the injection surface
 *   at zero. These two statements therefore do NOT interpolate anything: not a
 *   table name, not a column name, not an argument. Both are constant strings with
 *   no placeholder at all, they read the whole `public` catalogue once, and the
 *   requested table is selected from the returned rows IN JAVASCRIPT. A model name
 *   can never reach the SQL text — it is matched against an allowlist built from
 *   the DMMF model names first, and an unknown name never builds a query at all.
 *   Two statements, zero parameters, zero concatenation: there is no code path in
 *   this file where a string from the model reaches Postgres.
 *
 * WHAT IS NEVER RETURNED: row data, credentials, connection strings, settings.
 * Every value below is a NAME (model, field, relation, index, table), a TYPE, a
 * count, an estimate or a size — see describeDefault() for the one place a literal
 * could have leaked and the two rules that stop it. A schema answer that quoted a
 * stored password would be catastrophic, so the rule is enforced by construction:
 * there is no data source in this file to quote one from.
 */

const { z } = require('zod');
const { readTool, clampTake } = require('./_kit');

/** Hard ceiling on how many models `db_table_stats` will report in one call. */
const MAX_STATS_MODELS = 10;

/**
 * The only two statements in the whole agent that are raw SQL. Both are FIXED:
 * no `?`, no `$1`, no template literal, no concatenation, no caller input of any
 * kind. They enumerate the `public` catalogue and the filtering happens in JS.
 * `$queryRawUnsafe` is used (not `$queryRaw`) only because there is nothing
 * parameterised to parameterise; the "unsafe" in its name refers to string
 * building, and this file builds none.
 */
const INDEX_CATALOGUE_SQL =
  'SELECT tablename AS "tableName", indexname AS "indexName", indexdef AS "definition" ' +
  'FROM pg_indexes WHERE schemaname = \'public\' ORDER BY tablename, indexname';

/**
 * The DMMF model list, resolved once per process.
 *
 * Lazy on purpose: `@prisma/client` is a GENERATED artefact (`prisma generate`
 * runs in the Dockerfile build, `npm run db:setup` locally), so requiring it at
 * module load would make this file — and therefore the whole tool registry, which
 * requires it — throw on a checkout that has not generated yet. The other tool
 * files get away without deferring only because their Prisma access happens inside
 * execute(); this one runs from the DMMF, so it defers.
 */
let dmmfModelsCache = null;

function dmmfModels() {
  if (dmmfModelsCache) return dmmfModelsCache;
  const { Prisma } = require('@prisma/client');
  const datamodel = Prisma && Prisma.dmmf ? Prisma.dmmf.datamodel : null;
  const models = datamodel ? datamodel.models : [];
  dmmfModelsCache = Object.freeze(Array.isArray(models) ? models.slice() : []);
  return dmmfModelsCache;
}

/** Every model name — THE allowlist. Nothing else may be treated as a table. */
function modelNames() {
  return dmmfModels().map((model) => model.name);
}

/** Case-insensitive exact match against the allowlist, or null. */
function findAllowedModel(name) {
  const wanted = String(name === undefined || name === null ? '' : name).trim().toLowerCase();
  if (!wanted) return null;
  return dmmfModels().find((model) => model.name.toLowerCase() === wanted) || null;
}

/**
 * Physical table name for a model. `@@map` is honoured when present (this schema
 * uses none today, so it is the model name); the DMMF is the single source of that
 * mapping precisely so the two catalogues — compiled and live — cannot disagree.
 */
function tableNameOf(model) {
  return model.dbName || model.name;
}

/**
 * "Did you mean?" for an unknown model, scored without a model call.
 *
 * WHY THIS IS WORTH THE LINES: the alternative is returning
 * `{ok:false, reason:'UNKNOWN_MODEL'}` and letting the model guess again, which on
 * a 22-model schema is close to a coin flip. Three cheap signals (equality,
 * substring, shared prefix) cover the realistic typos — «Enrollmnt», «enrollment».
 */
function suggestModels(input) {
  const wanted = String(input || '').trim().toLowerCase();
  const scored = modelNames().map((name) => {
    const lower = name.toLowerCase();
    let score;
    if (lower === wanted) score = 1000;
    else if (wanted && (lower.includes(wanted) || wanted.includes(lower))) {
      score = 500 - Math.abs(lower.length - wanted.length);
    } else {
      let prefix = 0;
      while (prefix < Math.min(lower.length, wanted.length) && lower[prefix] === wanted[prefix]) {
        prefix += 1;
      }
      score = prefix * 4 - Math.abs(lower.length - wanted.length);
    }
    return { name, score };
  });
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const hits = scored.filter((entry) => entry.score > 0).map((entry) => entry.name);
  // Always hand back something: an empty suggestion list tells the model nothing.
  return hits.length ? hits.slice(0, 5) : modelNames().slice(0, 5);
}

const TABLE_STATS_SQL =
  'SELECT c.relname AS "tableName", c.reltuples::float8 AS "estimatedRows", ' +
  '(c.reltuples >= 0) AS "statsCollected", pg_total_relation_size(c.oid)::float8 AS "totalBytes" ' +
  'FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
  'WHERE n.nspname = \'public\' AND c.relkind = \'r\' ORDER BY c.relname';

/**
 * A field's default, rendered so that it can never carry a secret.
 *
 * A default is the ONE place in a schema answer where a LITERAL value appears, and
 * a literal is exactly what a secret looks like. Two rules close that:
 *   - numbers and booleans are echoed (no secret is a number);
 *   - a string is echoed only when it is an ENUM value of its own field or a short
 *     SCREAMING_CASE token (`EGP`, `PENDING`, `FIRST_SECONDARY`). Anything else
 *     becomes `literal`, because a free-form string default is the only shape that
 *     could hold an operator-supplied secret.
 * `env(...)` loses its argument too — a variable NAME is metadata rather than a
 * secret, but the rule here is "nothing from the environment, ever", and omitting
 * the name costs the answer nothing (the field's type already says what it is).
 */
function describeDefault(field) {
  if (!field.hasDefaultValue || field.default === undefined || field.default === null) return null;
  const value = field.default;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const enumValues = Array.isArray(field.enumValues) ? field.enumValues : [];
    if (enumValues.includes(value)) return value;
    return /^[A-Z][A-Z0-9_]{0,31}$/.test(value) ? value : 'literal';
  }
  if (typeof value === 'object' && typeof value.name === 'string') {
    const args = Array.isArray(value.args) ? value.args : [];
    // Only a primitive arg is rendered, and only the first: `dbgenerated(...)` can
    // carry an arbitrary expression and must not be quoted back.
    if (args.length === 1 && (typeof args[0] === 'number' || typeof args[0] === 'boolean')) {
      return `${value.name}(${args[0]})`;
    }
    return value.name;
  }
  return null;
}

/** One scalar/enum field, in the shape an answer can quote directly. */
function fieldRow(field) {
  return {
    name: field.name,
    kind: field.kind,
    type: field.type,
    list: Boolean(field.isList),
    required: Boolean(field.isRequired),
    nullable: !field.isRequired,
    id: Boolean(field.isId),
    unique: Boolean(field.isUnique),
    updatedAt: Boolean(field.isUpdatedAt),
    readOnly: Boolean(field.isReadOnly),
    default: describeDefault(field),
  };
}

/**
 * One relation field. `relationFromFields` is the foreign key the DMMF already
 * resolved for us — that is why this does not guess `${name}Id`, which would be
 * wrong for every m-n relation in this schema.
 */
function relationRow(field) {
  return {
    name: field.name,
    relatedModel: field.type,
    cardinality: field.isList ? 'many' : 'one',
    list: Boolean(field.isList),
    required: Boolean(field.isRequired),
    relationName: field.relationName || null,
    foreignKeyFields: Array.isArray(field.relationFromFields) ? field.relationFromFields.slice() : [],
    references: Array.isArray(field.relationToFields) ? field.relationToFields.slice() : [],
  };
}

/**
 * The unique constraints DMMF knows about, as `a+b` labels, de-duplicated.
 *
 * DMMF reports a compound unique BOTH in `uniqueFields` and in `uniqueIndexes`, so
 * a naive concatenation lists every constraint twice. These are the "is this model
 * looked up by a natural key" facts the overview surfaces — the reason an admin can
 * be told "الاشتراك مفهرس على (userId, courseId) فيمنع التكرار".
 */
function uniqueGroupLabels(model) {
  const seen = new Set();
  const groups = [];
  const add = (fields) => {
    if (!Array.isArray(fields) || fields.length === 0) return;
    const label = fields.join('+');
    if (seen.has(label)) return;
    seen.add(label);
    groups.push(label);
  };
  // `uniqueFields` holds ARRAYS of field names ([['userId','courseId']]), so a
  // scalar entry has to be wrapped rather than joined — joining the array itself
  // produced the junk label "userId,courseId" next to the real one.
  for (const group of model.uniqueFields || []) add(Array.isArray(group) ? group : [group]);
  for (const index of model.uniqueIndexes || []) add(index.fields || []);
  return groups;
}

/**
 * Columns out of a `CREATE ... INDEX ... USING btree (a, b)` definition.
 *
 * The quotes are stripped: Postgres emits `("userId", "courseId")` for any
 * capitalised column, and an answer that says "the index covers "userId" and
 * "courseId"" reads like a quoting bug to whoever reads it.
 */
function indexColumns(definition) {
  if (typeof definition !== 'string') return null;
  const open = definition.indexOf('(');
  const close = definition.lastIndexOf(')');
  if (open < 0 || close <= open) return null;
  return definition
    .slice(open + 1, close)
    .split(',')
    .map((part) => part.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    .join(', ');
}

const dbSchemaOverview = readTool({
  name: 'db_schema_overview',
  description:
    'قائمة جداول قاعدة البيانات (مخطط Prisma) مع عدد حقول كل جدول وعدد العلاقات وقيود التميز المفهرسة عليها. تُستخدم عند السؤال «ما الجداول الموجودة» أو «إيه المخطط». تقرأ من تعريف Prisma نفسه ولا تحتاج اتصالًا بقاعدة البيانات، ولا تعرض أي بيانات.',
  schema: z.object({
    search: z.string().min(1).max(64).optional().describe('فلتر جزئي على اسم الجدول (مثال: enroll) لعرض الجداول المطابقة فقط'),
    take: z.number().int().min(1).max(50).optional().describe('عدد الجداول في النتيجة (١ إلى ٥٠، الافتراضي ٢٥)'),
  }),
  // 600s: the SHAPE of the schema is a deploy-time artefact. A migration changes it
  // at deploy time, and every admin asking about it within the next ten minutes
  // should get the same answer — there is no slow-moving counter here that a short
  // TTL would make fresher.
  cacheTtlSeconds: 600,
  run: async (args) => {
    const take = clampTake(args.take, 25);
    const search = args.search ? args.search.trim().toLowerCase() : null;
    const all = dmmfModels();
    const matched = search ? all.filter((model) => model.name.toLowerCase().includes(search)) : all;
    const ordered = matched.slice().sort((a, b) => a.name.localeCompare(b.name));

    const page = ordered.slice(0, take).map((model) => {
      const relations = model.fields.filter((field) => field.kind !== 'scalar');
      const uniqueGroups = uniqueGroupLabels(model);
      return {
        model: model.name,
        table: tableNameOf(model),
        fields: model.fields.length,
        relations: relations.length,
        uniqueGroups,
        hasUnique: uniqueGroups.length > 0,
      };
    });

    return {
      search: args.search || null,
      modelCount: all.length,
      rows: page,
      returned: page.length,
      truncated: ordered.length > page.length,
    };
  },
});

const dbSchemaDetail = readTool({
  name: 'db_schema_detail',
  description:
    'تفاصيل جدول واحد كاملًا: كل عمود بنوعه وهل هو مطلوب أو قابل للقيمة الفارغة وهل له قيمة افتراضية، والعلاقات مع الجداول الأخرى ومفاتيحها الأجنبية، والفهارس وقيود التميز الحقيقية الموجودة في قاعدة البيانات. تُستخدم عند السؤال «إيه أعمدة جدول كذا».',
  schema: z.object({
    model: z.string().min(1).max(64).describe('اسم الجدول بالضبط كما في prisma/schema.prisma (مثال: Enrollment)'),
    take: z.number().int().min(1).max(50).optional().describe('عدد الأعمدة في النتيجة (١ إلى ٥٠، الافتراضي ٥٠)'),
  }),
  // 600s, same reason as db_schema_overview: an index appears at deploy time.
  cacheTtlSeconds: 600,
  run: async (args, ctx) => {
    const model = findAllowedModel(args.model);
    const take = clampTake(args.take, 50);

    // The allowlist is checked BEFORE anything else, so an unknown name costs zero
    // queries — there is no string in this branch that could ever have reached SQL.
    if (!model) {
      return {
        ok: false,
        reason: 'UNKNOWN_MODEL',
        model: String(args.model || ''),
        suggestions: suggestModels(args.model),
        modelCount: dmmfModels().length,
        rows: [],
        returned: 0,
        truncated: false,
      };
    }

    const table = tableNameOf(model);
    const relations = model.fields.filter((field) => field.kind !== 'scalar').map(relationRow);
    const fields = model.fields.filter((field) => field.kind === 'scalar');
    const page = fields.slice(0, take);

    // Real indexes come from the live catalogue. Fail-soft: a revoked privilege or
    // an unreachable database must degrade the answer to "DMMF-only", never fail
    // it — the admin still gets the columns and the relations.
    let indexRows = [];
    let indexesAvailable = true;
    try {
      const catalogue = await ctx.prisma.$queryRawUnsafe(INDEX_CATALOGUE_SQL);
      indexRows = (Array.isArray(catalogue) ? catalogue : [])
        .filter((row) => row && row.tableName === table)
        .map((row) => ({
          name: row.indexName,
          unique: /\bUNIQUE\b/i.test(String(row.definition || '')),
          columns: indexColumns(row.definition),
          definition: row.definition,
        }));
    } catch {
      indexesAvailable = false;
    }

    return {
      ok: true,
      model: model.name,
      table,
      fieldCount: fields.length,
      relationCount: relations.length,
      uniqueGroups: uniqueGroupLabels(model),
      primaryKey: (model.primaryKey && model.primaryKey.name) || null,
      rows: page.map(fieldRow),
      returned: page.length,
      truncated: fields.length > page.length,
      relations,
      indexes: indexRows,
      indexesAvailable,
    };
  },
});

const dbTableStats = readTool({
  name: 'db_table_stats',
  description:
    'حجم كل جدول وعدد صفوفه التقريبي مع حجم التخزين بالجنيه الميجابايت، اعتمادًا على إحصاءات مدير قواعد البيانات لا على عدّ الصفوف فعليًا. تُستخدم عند السؤال «كام جد في الداتابيز» أو «أي الجداول كبيرة».',
  schema: z.object({
    models: z
      .array(z.string().min(1).max(64))
      .max(MAX_STATS_MODELS)
      .optional()
      .describe('أسماء الجداول المطلوبة (حتى ١٠)؛ تُترك فارغة لعرض أضخم ٨ جداول'),
    take: z.number().int().min(1).max(50).optional().describe('عدد الجداول في النتيجة (١ إلى ٥٠، الافتراضي ١٠)'),
  }),
  // 60s, NOT 600s like the two shape tools: the point of this tool is that the
  // numbers feel live. `reltuples` is itself the planner's own estimate, which only
  // moves after ANALYZE, so a 60s cache costs nothing in accuracy and saves a
  // question asked twice in a row from re-reading the catalogue.
  cacheTtlSeconds: 60,
  run: async (args, ctx) => {
    const take = clampTake(args.take, MAX_STATS_MODELS);
    const requested = Array.isArray(args.models) ? args.models : [];
    const uniqueRequested = [
      ...new Set(requested.map((name) => String(name || '').trim()).filter(Boolean)),
    ];

    const unknown = uniqueRequested.filter((name) => !findAllowedModel(name));
    if (unknown.length) {
      // Same rule as db_schema_detail: refuse BEFORE building a query, so a name the
      // allowlist does not know cannot reach the database at all.
      return {
        ok: false,
        reason: 'UNKNOWN_MODEL',
        unknown,
        suggestions: unknown.flatMap((name) => suggestModels(name)).slice(0, 5),
        rows: [],
        returned: 0,
        truncated: false,
      };
    }

    // The cap is a CLAMP, not an error: a model that asked for 12 gets the first 10
    // plus a `droppedModels` list it can report, instead of a refusal it would retry
    // with the same 12 names.
    const capped = uniqueRequested.slice(0, MAX_STATS_MODELS);
    const droppedModels = uniqueRequested.slice(MAX_STATS_MODELS);

    const byTable = new Map(modelNames().map((name) => [tableNameOf(findAllowedModel(name)), name]));

    let statsByTable = new Map();
    let statsAvailable = true;
    try {
      const catalogue = await ctx.prisma.$queryRawUnsafe(TABLE_STATS_SQL);
      statsByTable = new Map(
        (Array.isArray(catalogue) ? catalogue : []).map((row) => [row.tableName, row])
      );
    } catch {
      statsAvailable = false;
    }

    const toRow = (tableName) => {
      const stat = statsByTable.get(tableName) || null;
      const bytes = stat ? Number(stat.totalBytes) || 0 : 0;
      return {
        model: byTable.get(tableName) || tableName,
        table: tableName,
        estimatedRows: stat ? Math.max(0, Math.round(Number(stat.estimatedRows) || 0)) : 0,
        // reltuples is -1 until the planner has ANALYZEd a table, and 0 for one it
        // has never seen. Saying which it is beats a confident "0 rows" that is wrong.
        statsCollected: Boolean(stat) && stat.statsCollected !== false,
        sizeBytes: bytes,
        sizeMb: Number((bytes / (1024 * 1024)).toFixed(2)),
      };
    };

    let selected;
    if (capped.length) {
      selected = capped.map((name) => tableNameOf(findAllowedModel(name)));
    } else {
      // No names given: the "most relevant handful" is the biggest tables, which is
      // what «كام في الداتابيز» is actually asking about.
      selected = [...byTable.keys()]
        .filter((tableName) => statsByTable.has(tableName))
        .sort(
          (a, b) =>
            (Number(statsByTable.get(b).totalBytes) || 0) - (Number(statsByTable.get(a).totalBytes) || 0)
        )
        .slice(0, MAX_STATS_MODELS);
    }

    const rows = selected.slice(0, take).map(toRow);
    const totalBytes = rows.reduce((sum, row) => sum + row.sizeBytes, 0);
    const unanalyzed = rows.filter((row) => !row.statsCollected).map((row) => row.table);

    return {
      ok: true,
      requestedModels: capped,
      droppedModels,
      rows,
      returned: rows.length,
      truncated: droppedModels.length > 0 || selected.length > rows.length,
      totalSizeMb: Number((totalBytes / (1024 * 1024)).toFixed(2)),
      statsAvailable,
      note: unanalyzed.length
        ? `لم تُجمع إحصاءات بعد لهذه الجداول، فالعدد التقريبي غير موثوق: ${unanalyzed.join(', ')}`
        : null,
      estimateSource: 'pg_class.reltuples',
    };
  },
});

module.exports = [dbSchemaOverview, dbSchemaDetail, dbTableStats];

