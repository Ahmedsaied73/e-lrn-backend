'use strict';
/* Agent tool payload BYTE cap (token cost) — pure: no DB, no Redis, no network.
 *
 * The row cap (AI_AGENT_MAX_TOOL_RESULT_ROWS, 50) bounds how many RECORDS a read
 * may return; it says nothing about how BIG those records are, and a tool result
 * is re-serialized into EVERY model call of the turn. These tests pin the additive
 * char cap that closes that hole, and the three properties that make it safe
 * rather than lossy:
 *
 *   1. A payload under the cap is BYTE-IDENTICAL to what finalize() produced
 *      before the cap existed — ordinary answers must not change at all.
 *   2. A fat payload comes back under the cap, with honest metadata
 *      (payloadTruncated / payloadChars / payloadRows) and its SCALARS intact
 *      (`total`, `returned`, `asOf` are the numbers an answer cites).
 *   3. The cap is config-clamped (a 1-char or 10-million env value is clamped),
 *      and it applies to ACTION payloads too, because finalize() is shared.
 *
 * Run: node --test tests/agent-tool-payload-cap.test.js
 */
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { z } = require('zod');
const config = require('../src/config/env');
const auditLog = require('../src/services/auditLog');
const { redactPayload } = require('../src/services/agent/pii');
const {
  execute,
  finalize,
  readTool,
  actionTool,
  maxToolResultChars,
  trimPayloadToBudget,
} = require('../src/services/agent/tools/_kit');
const { disconnectRedis } = require('../src/integrations/redis/redisClient');

const DEFAULT_CAP = 12000;

/**
 * Pin the cap for the duration of a case.
 *
 * WHY pin instead of inherit: the resolver reads a developer .env, so a machine
 * with AI_AGENT_MAX_TOOL_RESULT_CHARS set would otherwise turn these assertions
 * into a report of that machine's environment rather than of the contract. The
 * real env parsing is tested below, in a child process.
 */
function pinCap(value) {
  const original = config.aiAgent.maxToolResultChars;
  config.aiAgent.maxToolResultChars = value;
  return () => {
    config.aiAgent.maxToolResultChars = original;
  };
}

/** The original audit writer, restored after the suite stubs it out. */
const realAuditRecord = auditLog.record;
let restoreCap = null;

// The action cases below run a REAL actionTool through execute(), which writes an
// AuditLog row. The module object is shared, so replacing the method here is
// enough to keep this file DB-free — and the audit contract itself is already
// pinned by tests/agent-actions-crud.test.js.
before(() => {
  auditLog.record = async () => true;
});

after(async () => {
  auditLog.record = realAuditRecord;
  if (restoreCap) restoreCap();
  await disconnectRedis();
});

afterEach(() => {
  if (restoreCap) {
    restoreCap();
    restoreCap = null;
  }
});

/** A realistic wide admin row: Arabic text, an email, numbers, a timestamp. */
function fatRow(i) {
  return {
    id: 1000 + i,
    slug: `stu${String(i).padStart(9, '0')}ab`,
    name: `الطالب رقم ${i} محمد عبد الرحمن`,
    email: `student${i}@example.com`,
    phoneNumber: `0100${String(1000000 + i).slice(0, 7)}`,
    grade: 'THIRD_SECONDARY',
    role: 'STUDENT',
    createdAt: '2026-09-01T08:30:00.000Z',
    lastLoginAt: '2026-09-27T09:12:00.000Z',
    enrollments: [
      { courseId: 8, title: 'الأحياء للصف الثالث الثانوي', progress: 42, paid: true },
      { courseId: 9, title: 'الفysics للصف الثالث الثانوي', progress: 11, paid: true },
    ],
  };
}

/**
 * The shape a normal list read actually returns: one flat row, no nested
 * collections. 50 of these measure 8,741 chars, i.e. UNDER the 12,000 default —
 * which is the measurement the default cap is justified by (see env.js).
 */
function slimRow(i) {
  return {
    id: 1000 + i,
    slug: `stu${String(i).padStart(9, '0')}ab`,
    name: `الطالب رقم ${i} محمد`,
    email: `student${i}@example.com`,
    grade: 'THIRD_SECONDARY',
    courseTitle: 'الأحياء للصف الثالث الثانوي',
    progress: 42,
  };
}


/** A 200-row list read with the scalar totals a real tool ships alongside it. */
function fatPayload(rowCount = 200) {
  return {
    total: 4820,
    returned: rowCount,
    truncated: true,
    asOf: '2026-09-27T10:00:00.000Z',
    rows: Array.from({ length: rowCount }, (_, i) => fatRow(i)),
  };
}


describe('agent tool payload cap — a small payload is untouched', () => {
  it('is byte-identical to the pre-cap finalize() output', () => {
    restoreCap = pinCap(DEFAULT_CAP);
    const payload = {
      total: 2,
      returned: 1,
      asOf: '2026-09-27T10:00:00.000Z',
      rows: [fatRow(1)],
    };

    // The old behaviour, spelled out: finalize() was redactPayload(payload) and
    // nothing else. If these two differ by a single character, ordinary answers
    // have changed, which is exactly what the cap must never do.
    const before = JSON.stringify(redactPayload(payload));
    const result = finalize(payload, SIZE_PROBE_DEF, Date.now());

    assert.equal(JSON.stringify(result.data), before, 'a small payload must not change by one char');
    assert.equal('payloadTruncated' in result.data, false, 'no honesty fields on an untrimmed payload');
    assert.equal('payloadChars' in result.data, false, 'no size field on an untrimmed payload');
    assert.equal('payloadRows' in result.data, false, 'no row-count field on an untrimmed payload');
    assert.equal(result.meta.tool, '_payload_cap_probe', 'meta is unchanged');
    assert.equal(result.meta.cappedAt, 50, 'the ROW cap is untouched by this change');
  });

  it('leaves a normal 50-row read completely alone at the default cap', () => {
    restoreCap = pinCap(DEFAULT_CAP);
    // The row cap still ships 50 rows of the NORMAL width; the char cap must not
    // fight it. 50 slim rows measure 8,741 chars, so this stays untrimmed.
    const payload = { total: 50, returned: 50, rows: Array.from({ length: 50 }, (_, i) => slimRow(i)) };
    const chars = JSON.stringify(redactPayload(payload)).length;
    assert.ok(chars <= DEFAULT_CAP, `fixture assumption: a 50-row read is ${chars} chars, over the default cap`);
    assert.equal(trimPayloadToBudget(redactPayload(payload), maxToolResultChars()), null, 'no trim when it fits');
  });
});

describe('agent tool payload cap — a fat payload is trimmed and says so', () => {
  it('lands under the cap with honest metadata and its head rows', () => {
    restoreCap = pinCap(DEFAULT_CAP);
    const payload = fatPayload(200);
    const fullChars = JSON.stringify(redactPayload(payload)).length;

    const result = finalize(payload, SIZE_PROBE_DEF, Date.now());

    const shipped = JSON.stringify(result.data).length;
    assert.ok(shipped <= DEFAULT_CAP, `shipped payload is ${shipped} chars, over the ${DEFAULT_CAP} cap`);
    assert.equal(result.data.payloadTruncated, true, 'truncation must be declared');
    assert.equal(result.data.payloadChars, fullChars, 'payloadChars is the size BEFORE trimming');
    assert.ok(result.data.payloadChars > DEFAULT_CAP, 'payloadChars must be above the cap');
    assert.equal(result.data.payloadRows, 200, 'payloadRows is the total row count, not the shipped count');
    assert.ok(result.data.rows.length < 200, 'rows must actually have been cut');
    assert.deepEqual(
      result.data.rows[0],
      redactPayload(fatRow(0)),
      'the LEADING row survives (redacted), because admin tables are newest-first'
    );
  });

  it('keeps the payload valid JSON and keeps every scalar the answer cites', () => {
    restoreCap = pinCap(DEFAULT_CAP);
    const result = finalize(fatPayload(200), SIZE_PROBE_DEF, Date.now());

    const roundTripped = JSON.parse(JSON.stringify(result.data));
    assert.equal(roundTripped.total, 4820, 'the grand total is not retrievable by re-querying — it must survive');
    assert.equal(roundTripped.returned, 200, 'returned is a scalar and must survive');
    assert.equal(roundTripped.asOf, '2026-09-27T10:00:00.000Z', 'asOf must survive');
    assert.equal(roundTripped.truncated, true, "the tool's own flag is untouched");
    assert.ok(Array.isArray(roundTripped.rows), 'rows is still an array — the cap never returns half an object');
    assert.ok(
      JSON.stringify(roundTripped).length <= DEFAULT_CAP,
      'a re-serialization of the shipped payload stays under the cap'
    );
  });

  it('honours a tightened cap instead of approximating it', () => {
    restoreCap = pinCap(2000);
    const small = finalize(fatPayload(200), SIZE_PROBE_DEF, Date.now());
    restoreCap = null;
    assert.ok(JSON.stringify(small.data).length <= 2000, 'a 2k cap must be respected, not approximated');
    assert.ok(small.data.rows.length > 0, 'a 2k cap still ships rows — the answer is not emptied');
    assert.equal(small.data.payloadRows, 200, 'the true row count is still declared');
  });

  it('trims `rows` before any other list, and falls through to it only when needed', () => {
    // Case A — `rows` is the bulk and the other list is small, so `rows` absorbs
    // the whole cut and the other list is never touched.
    const payload = {
      total: 300,
      rows: Array.from({ length: 60 }, () => fatRow(9)),
      items: [1, 2, 3],
    };
    restoreCap = pinCap(3000);
    const { data } = finalize(payload, SIZE_PROBE_DEF, Date.now());
    restoreCap = null;
    assert.ok(data.rows.length > 0 && data.rows.length < 60, 'rows is trimmed first');
    assert.equal(data.items.length, 3, 'the other list is untouched while rows can still give way');
    assert.equal(data.payloadRows, 60, 'payloadRows counts rows, not items');
    assert.equal(data.total, 300, 'scalars survive');

    // Case B — both lists are over budget on their own, so `rows` is given up
    // COMPLETELY before `items` gives up anything: the order is a priority, not a
    // proportional split, and a half-empty `rows` is worse than an empty one
    // because it reads as "that is all of them".
    const both = {
      total: 300,
      rows: Array.from({ length: 60 }, () => fatRow(9)),
      items: Array.from({ length: 60 }, () => fatRow(9)),
    };
    restoreCap = pinCap(3000);
    const second = finalize(both, SIZE_PROBE_DEF, Date.now());
    restoreCap = null;
    assert.equal(second.data.rows.length, 0, 'rows is exhausted before items is touched');
    assert.ok(second.data.items.length < 60, 'only then does the other list give way');
    assert.equal(second.data.total, 300, 'still no scalar is dropped');
    assert.equal(second.data.payloadRows, 60, 'the row count is still declared honestly');
  });
});

const SIZE_PROBE_DEF = readTool({
  name: '_payload_cap_probe',
  description: 'أداة داخلية لقياس حِجم الحمولة قبل وبعد سقف الأحرف',
  cacheTtlSeconds: 0,
  run: async () => fatPayload(),
});

describe('agent tool payload cap — the cap is configuration, not a constant', () => {
  // src/config/env.js is module-cached, so each env case runs in its own process
  // (the same technique tests/ai-agent-config.test.js uses).
  const BASE_ENV = {
    JWTSECRET: 'payload-cap-test-secret-1',
    ADMIN_PASSWORD: 'payload-cap-test-pass',
    BUNNY_STREAM_LIBRARY_ID: '1',
    BUNNY_STREAM_API_KEY: 'test',
    BUNNY_STREAM_READ_ONLY_API_KEY: 'test',
    BUNNY_STREAM_TOKEN_KEY: 'test',
    NODE_ENV: 'test',
    AI_AGENT_ENABLED: 'true',
    GEMINI_API_KEY: 'gemini-looking-key',
    AI_AGENT_MAX_TOOL_RESULT_CHARS: '',
  };

  function resolveCap(value) {
    const env = { ...process.env, ...BASE_ENV, AI_AGENT_MAX_TOOL_RESULT_CHARS: value };
    const stdout = execFileSync(
      process.execPath,
      ['-e', "process.stdout.write(String(require('./src/config/env').aiAgent.maxToolResultChars));"],
      { env, encoding: 'utf8' }
    );
    return Number(stdout);
  }

  it('defaults to 12,000 chars when unset', () => {
    assert.equal(resolveCap(''), DEFAULT_CAP, 'default cap');
  });

  it('clamps a 1-char budget up to the floor instead of honouring it', () => {
    assert.equal(resolveCap('1'), 2000, 'a 1-char cap would leave the agent unable to answer at all');
  });

  it('clamps a 10-million budget down to the ceiling instead of honouring it', () => {
    assert.equal(resolveCap('10000000'), 60000, 'an unclamped cap would put the spend bound back to zero');
  });

  it('accepts an honest in-range value, and garbage falls back to the default', () => {
    assert.equal(resolveCap('20000'), 20000, 'a sane budget is honoured');
    assert.equal(resolveCap('abc'), DEFAULT_CAP, 'garbage is not a number');
  });
});

describe('agent tool payload cap — actions are capped by the same funnel', () => {
  const ACTION_DEF = actionTool({
    name: '_payload_cap_action',
    description: 'أداة داخلية للتأكد من أن الحمولة تُقصّ في نفس المخرجات',
    schema: z.object({ size: z.number().int().positive() }),
    audit: { action: 'USER_UPDATE', targetType: 'user' },
    run: async (args) => ({
      targetId: 7,
      status: 'ok',
      rows: Array.from({ length: args.size }, (_, i) => fatRow(i)),
    }),
  });

  it('caps an APPROVED action payload exactly like a read', async () => {
    restoreCap = pinCap(DEFAULT_CAP);
    const result = await execute(
      ACTION_DEF,
      { size: 200 },
      { prisma: {}, approved: true, adminId: 1, conversationId: 2 }
    );
    restoreCap = null;

    assert.ok(JSON.stringify(result.data).length <= DEFAULT_CAP, 'an action result is capped too');
    assert.equal(result.data.payloadTruncated, true, 'the action says it trimmed');
    assert.equal(result.data.payloadRows, 200, 'the action declares the true row count');
    assert.equal(result.data.status, 'ok', 'the action scalars survive');
    assert.equal(result.data.targetId, 7, 'the audit target id is never trimmed away');
  });

  it('leaves a small action payload byte-identical', async () => {
    restoreCap = pinCap(DEFAULT_CAP);
    const result = await execute(ACTION_DEF, { size: 3 }, { prisma: {}, approved: true, adminId: 1, conversationId: 2 });
    restoreCap = null;
    assert.equal('payloadTruncated' in result.data, false, 'a small action result is untouched');
    assert.equal(result.data.rows.length, 3, 'all three rows ship');
  });
});
