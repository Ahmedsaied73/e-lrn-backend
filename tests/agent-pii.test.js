'use strict';
/* PII policy tests (Phase 1) — pure functions, no DB, no network.
 *
 * The approved policy is asymmetric on purpose and these tests lock it in:
 *   - EMAILS are masked before any payload can reach a model;
 *   - NAMES and PHONE NUMBERS pass through untouched.
 * A future change to either direction must fail here first.
 *
 * Run: npm test
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { containsEmail, maskEmail, redactEmailsInText, redactPayload } = require('../src/services/agent/pii');

describe('agent PII — email redaction', () => {
  it('masks the local part and keeps the domain', () => {
    assert.equal(maskEmail('ahmed.saied@gmail.com'), 'a***@gmail.com');
    assert.equal(maskEmail('x@y.com'), 'x***@y.com');
    assert.equal(maskEmail('student+tag@school.edu.eg'), 's***@school.edu.eg');
  });

  it('leaves non-addresses alone (never throws on junk)', () => {
    assert.equal(maskEmail('not-an-email'), 'not-an-email');
    assert.equal(maskEmail('@example.com'), '@example.com');
    assert.equal(maskEmail(''), '');
    assert.equal(maskEmail(null), null);
  });

  it('redacts every address inside free text but keeps the text', () => {
    const input = 'الطالب ahmed@gmail.com لم يسدّد، وزميله sara@school.edu.eg سدّد.';
    const out = redactEmailsInText(input);
    assert.ok(out.includes('a***@gmail.com'), 'first address masked');
    assert.ok(out.includes('s***@school.edu.eg'), 'second address masked');
    assert.ok(!out.includes('ahmed@gmail.com') && !out.includes('sara@school.edu.eg'), 'no raw address remains');
    assert.ok(out.includes('لم يسدّد'), 'surrounding Arabic text intact');
  });

  it('detects addresses for assertions elsewhere', () => {
    assert.equal(containsEmail('a@b.com'), true);
    assert.equal(containsEmail('a***@b.com'), false);
    assert.equal(containsEmail('01001234567'), false);
  });
});

describe('agent PII — payload policy', () => {
  it('redacts emails in nested rows and does not touch names or phones', () => {
    const payload = {
      rows: [
        { name: 'أحمد سعيد', phoneNumber: '01001234567', email: 'ahmed@example.com', grade: 'FIRST_SECONDARY' },
        { name: 'سارة', phoneNumber: '01112223333', email: 'sara@school.edu.eg', nested: { cc: 'ops@x.io' } },
      ],
    };
    const out = redactPayload(payload);
    assert.equal(out.rows[0].email, 'a***@example.com', 'email masked');
    assert.equal(out.rows[1].nested.cc, 'o***@x.io', 'nested email masked');
    assert.equal(out.rows[0].name, 'أحمد سعيد', 'name allowed (approved policy)');
    assert.equal(out.rows[0].phoneNumber, '01001234567', 'phone allowed (approved policy)');
    assert.equal(out.rows[0].grade, 'FIRST_SECONDARY', 'non-PII untouched');
  });

  it('never mutates the caller payload (Prisma objects are reused elsewhere)', () => {
    const payload = { student: { email: 'keep@me.com' } };
    const out = redactPayload(payload);
    assert.equal(payload.student.email, 'keep@me.com', 'original unchanged');
    assert.equal(out.student.email, 'k***@me.com', 'copy redacted');
  });

  it('is idempotent — double redaction cannot corrupt an already-masked payload', () => {
    const once = redactPayload({ email: 'ahmed@gmail.com' });
    const twice = redactPayload(once);
    assert.deepEqual(twice, once, 'masking a masked value is a no-op');
  });

  it('survives nulls, Dates, arrays and deep nesting without throwing', () => {
    const when = new Date('2026-09-24T10:00:00.000Z');
    const out = redactPayload({ a: null, b: undefined, c: when, d: [1, 'x@y.com', { e: 'f@g.com' }] });
    assert.equal(out.a, null);
    assert.equal(out.b, undefined);
    assert.equal(out.c, when, 'Date passes through (JSON layer serializes it)');
    assert.equal(out.d[0], 1);
    assert.equal(out.d[1], 'x***@y.com');
    assert.equal(out.d[2].e, 'f***@g.com');
  });

  it('bounds recursion depth instead of walking an absurd structure', () => {
    let deep = { email: 'deep@x.com' };
    for (let i = 0; i < 30; i++) deep = { nested: deep };
    const out = redactPayload(deep);
    assert.ok(JSON.stringify(out).includes('truncated:depth'), 'depth cap is visible, not silent');
  });
});
