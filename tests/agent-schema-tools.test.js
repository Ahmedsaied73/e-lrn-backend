'use strict';
/* Agent SCHEMA tools — pure: no database, no Redis, no network.
 *
 * The properties pinned here are the ones that make it safe to hand a model the
 * shape of the database at all:
 *   1. All three register as ordinary cached read tools, Arabic, with an Arabic
 *      `.describe()` on every argument (so the model can actually call them).
 *   2. db_schema_overview is DMMF-ONLY: it answers with a Prisma client that
 *      throws on ANY property access, which is the proof that it still works with
 *      the database down and cannot leak a connection string through a client.
 *   3. An unknown table is refused STRUCTURALLY, with zero queries, and comes back
 *      with "did you mean" suggestions — never as a raw Prisma error.
 *   4. The two raw statements are FIXED: the requested table never appears in the
 *      SQL text and there is no placeholder to bind it to.
 *   5. db_table_stats clamps to 10 models and refuses an unknown one WITHOUT
 *      building a query for it.
 *   6. No payload can carry a credential: every string value a payload can contain
 *      is proven to be schema vocabulary (see assertNoCredential).
 *
 * Run: node --test tests/agent-schema-tools.test.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readDefinitions, actionDefinitions, getDefinition, listDefinitions } = require('../src/services/agent/tools');
const { execute } = require('../src/services/agent/tools/_kit');
const envConfig = require('../src/config/env');
const { disconnectRedis } = require('../src/integrations/redis/redisClient');
const { Prisma } = require('@prisma/client');

const ARABIC_RE = /[\u0600-\u06FF]/;
const SCHEMA_TOOLS = ['db_schema_overview', 'db_schema_detail', 'db_table_stats'];

/**
 * The shared cache is pinned OFF for the whole file. Two reasons, both about
 * determinism rather than speed: a cache HIT would silently serve a payload from a
 * previous test (so "the unknown model issued zero queries" could pass on a
 * payload that was never computed here), and a live Redis handle would keep the
 * runner alive. This mirrors the existing tool tests.
 */
let originalRedisEnabled = null;

before(() => {
  originalRedisEnabled = envConfig.redis.enabled;
  envConfig.redis.enabled = false;
});

after(async () => {
  envConfig.redis.enabled = originalRedisEnabled;
  await disconnectRedis();
});

/** The DMMF models, the same source the tools read. */
const MODELS = Prisma.dmmf.datamodel.models;

/**
 * A Prisma stand-in that records every statement it is handed. It answers the
 * index catalogue from `indexes` and the statistics catalogue from `stats`, so a
 * test can prove which of the two statements a tool chose to run.
 */
function prismaStub({ indexes = [], stats = [], fail = false } = {}) {
  const seen = [];
  return {
    seen,
    async $queryRawUnsafe(sql) {
      seen.push(sql);
      if (fail) throw new Error('permission denied for schema catalogue');
      return sql.includes('pg_indexes') ? indexes : stats;
    },
  };
}

/** A Prisma client that explodes on ANY property access — the DMMF-only proof. */
function explodingPrisma() {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`the tool touched prisma.${String(prop)}`);
      },
    }
  );
}

/** Every string value anywhere in a payload, at any depth. */
function stringValues(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringValues(item, out));
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) stringValues(item, out);
  }
  return out;
}

/**
 * The vocabulary a schema payload is allowed to speak, derived from the DMMF
 * rather than hardcoded: a model name, a field name, a Prisma type, a relation
 * name, an enum value, or one of this suite's own literal labels.
 *
 * This is the strong form of the "no credentials" rule. A payload value outside
 * this set would be data the tools have no business reading — and there is no code
 * path in schema.js that could produce one, so the assertion cannot pass by luck.
 */
const ALLOWED_VOCABULARY = new Set([
  'scalar',
  'object',
  'enum',
  'one',
  'many',
  'literal',
  'public',
  'pg_class.reltuples',
  'autoincrement',
  'now',
  'unique',
  'btree',
]);

function vocabularyAllowlist() {
  for (const model of MODELS) {
    ALLOWED_VOCABULARY.add(model.name);
    ALLOWED_VOCABULARY.add(model.dbName || model.name);
    for (const field of model.fields) {
      ALLOWED_VOCABULARY.add(field.name);
      ALLOWED_VOCABULARY.add(field.type);
      if (field.relationName) ALLOWED_VOCABULARY.add(field.relationName);
      for (const value of field.enumValues || []) ALLOWED_VOCABULARY.add(value);
    }
  }
  return ALLOWED_VOCABULARY;
}

/**
 * A payload is safe to hand a model when (a) no value is a URL or a connection
 * string, and (b) every DMMF-derived value is schema vocabulary. (b) is stated
 * separately because the index/statistics rows come from the stub in these tests,
 * not from the DMMF.
 */
function assertNoCredential(payload, label, { vocabularyOnly = false } = {}) {
  const values = stringValues(payload);
  for (const value of values) {
    assert.doesNotMatch(value, /:\/\//, `${label}: a payload value looks like a URL/connection string — ${value}`);
    assert.doesNotMatch(value, /DATABASE_URL|DIRECT_URL|JWTSECRET|REFRESH_TOKEN_SECRET/i, `${label}: an env var name leaked`);
  }
  if (!vocabularyOnly) return;
  const allowed = vocabularyAllowlist();
  for (const value of values) {
    // A compound label ("userId+courseId") is vocabulary too — but only because
    // every one of its parts is a declared field name, which is checked here
    // rather than assumed.
    const parts = value.split('+');
    assert.ok(
      parts.every((part) => allowed.has(part)),
      `${label}: "${value}" is not schema vocabulary — the tool read data`
    );
  }
}

/**
 * The index rows a real `pg_indexes` query returns, copied from the live staging
 * database (including the identifier quotes Postgres adds for capitalised
 * columns) so the test pins reality rather than an invented shape.
 */
const INDEX_CATALOGUE = [
  {
    tableName: 'Enrollment',
    indexName: 'Enrollment_userId_courseId_key',
    definition:
      'CREATE UNIQUE INDEX "Enrollment_userId_courseId_key" ON public."Enrollment" USING btree ("userId", "courseId")',
  },
  {
    tableName: 'Enrollment',
    indexName: 'Enrollment_courseId_idx',
    definition: 'CREATE INDEX "Enrollment_courseId_idx" ON public."Enrollment" USING btree ("courseId")',
  },
  {
    tableName: 'Course',
    indexName: 'Course_pkey',
    definition: 'CREATE UNIQUE INDEX "Course_pkey" ON public."Course" USING btree (id)',
  },
];

/** The statistics rows a real `pg_class` query would return. */
const STATS_CATALOGUE = [
  { tableName: 'Enrollment', estimatedRows: 20431, statsCollected: true, totalBytes: 3145728 },
  { tableName: 'User', estimatedRows: 5120, statsCollected: true, totalBytes: 2097152 },
  { tableName: 'Course', estimatedRows: 37, statsCollected: true, totalBytes: 65536 },
  { tableName: 'AgentMessage', estimatedRows: -1, statsCollected: false, totalBytes: 8192 },
];

describe('agent schema tools — registry', () => {
  it('registers all three as cached, read-only, Arabic tools', () => {
    for (const name of SCHEMA_TOOLS) {
      const def = getDefinition(name);
      assert.ok(def, `${name} must be registered`);
      assert.equal(def.kind, 'read', `${name} must be a READ tool`);
      assert.equal(def.requiresApproval, false, `${name} must never require approval`);
      assert.ok(def.cacheTtlSeconds > 0, `${name} must declare a cache TTL`);
      assert.match(def.description, ARABIC_RE, `${name} description must be Arabic`);
      assert.ok(def.description.length >= 20, `${name} description must be explanatory`);
      assert.ok(readDefinitions.includes(def), `${name} must be in the read catalogue`);
      assert.equal(
        actionDefinitions.some((action) => action.name === name),
        false,
        `${name} must never appear in the mutating catalogue`
      );
    }
  });

  it('gives every argument an Arabic .describe() so the model can fill it in', () => {
    for (const name of SCHEMA_TOOLS) {
      const shape = getDefinition(name).schema.shape;
      const keys = Object.keys(shape);
      assert.ok(keys.length > 0, `${name} must take at least one argument`);
      for (const key of keys) {
        const description = shape[key].description;
        assert.equal(typeof description, 'string', `${name}.${key} needs a .describe()`);
        assert.match(description, ARABIC_RE, `${name}.${key} description must be Arabic`);
        assert.ok(description.length >= 5, `${name}.${key} description must be explanatory`);
      }
    }
  });

  it('is reachable: a schema tool is in the read catalogue and on every turn', () => {
    // Phase 1 (v2): the model-facing surface is the whole read catalogue, so a schema
    // tool can no longer be dropped for lack of a matching keyword (the Phase 4.5
    // selector used to decide that from each tool's Arabic description). What still
    // matters is that all three are registered AND bound, so a database question reaches
    // the tool that can answer it.
    const boundNames = listDefinitions().map((def) => def.name);
    for (const name of SCHEMA_TOOLS) {
      assert.ok(readDefinitions.some((def) => def.name === name), `${name} must be in the read catalogue`);
      assert.ok(boundNames.includes(name), `${name} must be on the model-facing surface`);
    }
  });
});

describe('agent schema tools — db_schema_overview', () => {
  it('answers with a Prisma client that has no query methods at all', async () => {
    const { data } = await execute(getDefinition('db_schema_overview'), {}, { prisma: explodingPrisma() });
    assert.equal(data.modelCount, MODELS.length, 'it must report the real DMMF model count');
    assert.equal(data.rows.length, MODELS.length);
    assert.ok(data.rows.length >= 20, `expected 20+ models, got ${data.rows.length}`);
    assert.equal(data.returned, data.rows.length);
    assert.equal(data.truncated, false);
    assertNoCredential(data, 'db_schema_overview', { vocabularyOnly: true });

    const enrollment = data.rows.find((row) => row.model === 'Enrollment');
    assert.ok(enrollment, 'Enrollment must be listed');
    assert.equal(enrollment.table, 'Enrollment');
    assert.ok(enrollment.fields > 10, `Enrollment has 11 fields, got ${enrollment.fields}`);
    assert.equal(enrollment.relations, 2);
    assert.deepEqual(enrollment.uniqueGroups, ['userId+courseId'], 'the compound unique must be surfaced once');
    assert.equal(enrollment.hasUnique, true);
  });

  it('filters by search and honours the row cap', async () => {
    const prisma = explodingPrisma();
    const filtered = await execute(getDefinition('db_schema_overview'), { search: 'enroll' }, { prisma });
    assert.ok(filtered.data.rows.length > 0, 'a search must return something');
    for (const row of filtered.data.rows) {
      assert.match(row.model.toLowerCase(), /enroll/, `${row.model} does not match the search`);
    }

    const capped = await execute(getDefinition('db_schema_overview'), { take: 2 }, { prisma });
    assert.equal(capped.data.returned, 2);
    assert.equal(capped.data.truncated, true, 'a capped page must admit it');
    assert.ok(capped.data.modelCount > 2, 'modelCount stays the real total, not the page size');
  });
});


describe('agent schema tools — db_schema_detail', () => {
  it('refuses an unknown model with zero queries and a useful suggestion', async () => {
    const prisma = prismaStub({ indexes: INDEX_CATALOGUE });
    const { data } = await execute(getDefinition('db_schema_detail'), { model: 'Enrollmnt' }, { prisma });
    assert.equal(data.ok, false);
    assert.equal(data.reason, 'UNKNOWN_MODEL');
    assert.equal(data.model, 'Enrollmnt');
    assert.ok(data.suggestions.includes('Enrollment'), `expected a real suggestion, got ${data.suggestions}`);
    assert.equal(data.rows.length, 0);
    assert.equal(prisma.seen.length, 0, 'an unknown model must not reach the database');
  });

  it('returns the fields, the relations and the REAL indexes of one model', async () => {
    const prisma = prismaStub({ indexes: INDEX_CATALOGUE });
    const { data } = await execute(getDefinition('db_schema_detail'), { model: 'Enrollment' }, { prisma });

    assert.equal(data.ok, true);
    assert.equal(data.model, 'Enrollment');
    assert.equal(data.indexesAvailable, true);
    assert.equal(data.rows.length, data.fieldCount, 'every scalar field must be listed');
    assert.equal(data.truncated, false);
    assert.deepEqual(data.uniqueGroups, ['userId+courseId']);

    const userId = data.rows.find((row) => row.name === 'userId');
    assert.deepEqual(
      { type: userId.type, required: userId.required, default: userId.default, id: userId.id },
      { type: 'Int', required: true, default: null, id: false }
    );
    const isPaid = data.rows.find((row) => row.name === 'isPaid');
    assert.equal(isPaid.default, false, 'a boolean default is safe to quote and must be quoted');
    const createdAt = data.rows.find((row) => row.name === 'createdAt');
    assert.equal(createdAt.default, 'now');

    const relation = data.relations.find((row) => row.name === 'user');
    assert.equal(relation.relatedModel, 'User');
    assert.equal(relation.cardinality, 'one');
    assert.deepEqual(relation.foreignKeyFields, ['userId'], 'the FK comes from the DMMF, not from a guess');

    assert.equal(data.indexes.length, 2, 'only the indexes of THIS table');
    const unique = data.indexes.find((row) => row.unique);
    assert.equal(unique.name, 'Enrollment_userId_courseId_key');
    assert.equal(unique.columns, 'userId, courseId');
    assertNoCredential(data, 'db_schema_detail');
  });

  it('sends a FIXED statement: the requested table is never in the SQL text', async () => {
    const prisma = prismaStub({ indexes: INDEX_CATALOGUE });
    await execute(getDefinition('db_schema_detail'), { model: 'Enrollment' }, { prisma });
    assert.equal(prisma.seen.length, 1, 'one catalogue read, one table');
    const sql = prisma.seen[0];
    assert.ok(!/Enrollment/i.test(sql), 'the requested table must not reach the SQL text');
    assert.doesNotMatch(sql, /\?|\$\d/, 'the statement must have no placeholder to bind anything to');
    assert.match(sql, /FROM pg_indexes/);
  });

  it('degrades to DMMF-only instead of failing when the catalogue is unreadable', async () => {
    const prisma = prismaStub({ fail: true });
    const { data } = await execute(getDefinition('db_schema_detail'), { model: 'Course' }, { prisma });
    assert.equal(data.ok, true, 'the schema question must still be answered');
    assert.equal(data.indexesAvailable, false, 'the answer must say the indexes are unknown');
    assert.deepEqual(data.indexes, []);
    assert.ok(data.rows.length > 0, 'the columns still come from the DMMF');
  });
});


describe('agent schema tools — db_table_stats', () => {
  it('reports estimates and sizes for the models it is asked about', async () => {
    const prisma = prismaStub({ stats: STATS_CATALOGUE });
    const { data } = await execute(getDefinition('db_table_stats'), { models: ['Enrollment', 'User'] }, { prisma });

    assert.equal(data.ok, true);
    assert.equal(data.returned, 2);
    assert.equal(data.truncated, false);
    assert.equal(data.estimateSource, 'pg_class.reltuples');
    assert.equal(data.totalSizeMb, 5, '3MiB + 2MiB');

    const enrollment = data.rows[0];
    assert.equal(enrollment.model, 'Enrollment');
    assert.equal(enrollment.estimatedRows, 20431, 'an ESTIMATE, never a COUNT(*)');
    assert.equal(enrollment.statsCollected, true);
    assert.equal(enrollment.sizeMb, 3);
    assert.equal(prisma.seen.length, 1);
  });

  it('caps the model list at 10, at the schema and again at the row cap', async () => {
    // Zod caps the array at 10, so 14 names is a refusal at the validation layer:
    // the tool never sees them and therefore never builds a query for them.
    const prisma = prismaStub({ stats: STATS_CATALOGUE });
    await assert.rejects(
      () =>
        execute(getDefinition('db_table_stats'), { models: MODELS.slice(0, 14).map((m) => m.name) }, { prisma }),
      (err) => err.code === 'INVALID_ARGS'
    );
    assert.equal(prisma.seen.length, 0, 'a rejected argument list must not reach the database');

    // The 10 that DO fit are returned, never more than MAX_STATS_MODELS.
    const ten = await execute(
      getDefinition('db_table_stats'),
      { models: MODELS.slice(0, 10).map((m) => m.name) },
      { prisma }
    );
    assert.equal(ten.data.returned, 10);
    assert.ok(ten.data.returned <= 10);
    assert.deepEqual(ten.data.droppedModels, []);

    // And `take` below the list length is honoured with an honest truncation flag.
    const fewer = await execute(
      getDefinition('db_table_stats'),
      { models: ['Enrollment', 'User'], take: 1 },
      { prisma }
    );
    assert.equal(fewer.data.returned, 1);
    assert.equal(fewer.data.truncated, true);
  });

  it('refuses an unknown model name without building a query for it', async () => {
    const prisma = prismaStub({ stats: STATS_CATALOGUE });
    const { data } = await execute(
      getDefinition('db_table_stats'),
      { models: ['Enrollment', 'pg_shadow; DROP TABLE "User"'] },
      { prisma }
    );
    assert.equal(data.ok, false);
    assert.equal(data.reason, 'UNKNOWN_MODEL');
    assert.deepEqual(data.unknown, ['pg_shadow; DROP TABLE "User"']);
    assert.ok(data.suggestions.length > 0, 'a refusal must come with something to try instead');
    assert.equal(data.rows.length, 0);
    assert.equal(prisma.seen.length, 0, 'an unknown name must not reach the database');
  });

  it('defaults to the biggest tables and flags a never-analysed one', async () => {
    const prisma = prismaStub({ stats: STATS_CATALOGUE });
    const { data } = await execute(getDefinition('db_table_stats'), {}, { prisma });
    assert.equal(data.ok, true);
    assert.ok(data.rows.length > 0, 'the default must answer something');
    assert.equal(data.rows[0].table, 'Enrollment', 'the biggest table first');
    const sizes = data.rows.map((row) => row.sizeBytes);
    assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a), 'the default list is ordered by size');

    // AgentMessage is never ANALYZEd: reltuples is -1, and saying so beats a
    // confident "0 rows".
    const unanalyzed = await execute(
      getDefinition('db_table_stats'),
      { models: ['AgentMessage'] },
      { prisma: prismaStub({ stats: STATS_CATALOGUE }) }
    );
    assert.equal(unanalyzed.data.rows[0].estimatedRows, 0);
    assert.equal(unanalyzed.data.rows[0].statsCollected, false);
    assert.match(unanalyzed.data.note, /AgentMessage/);
  });
});


describe('agent schema tools — nothing can leak', () => {
  it('carries no credential, URL or environment value in any payload', async () => {
    const overview = await execute(getDefinition('db_schema_overview'), {}, { prisma: explodingPrisma() });
    const detail = await execute(
      getDefinition('db_schema_detail'),
      { model: 'User' },
      { prisma: prismaStub({ indexes: [] }) }
    );
    const stats = await execute(
      getDefinition('db_table_stats'),
      { models: ['User', 'Enrollment'] },
      { prisma: prismaStub({ stats: STATS_CATALOGUE }) }
    );

    assertNoCredential(overview.data, 'db_schema_overview');
    assertNoCredential(detail.data, 'db_schema_detail');
    assertNoCredential(stats.data, 'db_table_stats');

    // The literal scan, on the two payloads that never emit a COLUMN name.
    // (db_schema_detail is exempt from this one on purpose and only on purpose: a
    // schema tool that hid the `password` column could not answer "is it hashed?",
    // and the vocabulary assertion in assertNoCredential is the stronger guarantee
    // for that payload — it proves no value outside prisma/schema.prisma can be
    // produced at all.)
    for (const [label, payload] of [
      ['db_schema_overview', overview.data],
      ['db_table_stats', stats.data],
    ]) {
      for (const value of stringValues(payload)) {
        assert.doesNotMatch(value, /password|api[_-]?key|secret/i, `${label}: "${value}" looks like a credential`);
      }
    }
  });

  it('is bounded by the shared tool row cap like every other read', async () => {
    // The kit's clamp is what keeps `take` from becoming a page-size knob, so the
    // proof lowers the CAP itself (the schema's own .max(50) is the outer bound
    // and is shared with every other read tool in the catalogue).
    const original = envConfig.aiAgent.maxToolResultRows;
    envConfig.aiAgent.maxToolResultRows = 5;
    try {
      const capped = await execute(getDefinition('db_schema_overview'), { take: 50 }, { prisma: explodingPrisma() });
      assert.equal(capped.data.returned, 5, 'clampTake must win over a larger take');
      assert.equal(capped.data.truncated, true);
      assert.equal(capped.meta.cappedAt, 5, 'the meta must report the cap the kit applied');
      assert.equal(capped.data.modelCount, MODELS.length, 'the real total is still reported');
    } finally {
      envConfig.aiAgent.maxToolResultRows = original;
    }
  });
});

