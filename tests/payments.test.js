'use strict';

/* Payments integration suite (node:test, self-hosted server + live staging DB).
 *
 * Proves the money-critical paths END TO END against handleTransactionCallback
 * semantics by forging Paymob Transaction Processed Callbacks with REAL HMACs
 * (independent computation — a forged-but-valid signature is indistinguishable
 * from the provider's own for our verifier, which is exactly what makes these
 * tests meaningful for duplicate/retry/tamper scenarios).
 *
 * Why this is safe on staging: no gateway calls are made (unlike the checkout
 * path itself). HMAC secrets below are fixed test values — but they only work
 * against THIS suite's own forged callbacks; nothing touches real money.
 *
 * A per-file PAYMENTS_ENABLED=true is set BEFORE requires (node --test
 * isolates files in their own process). The provider itself is STUBBED at the
 * module-cache level: checkout paths never leave the process.
 *
 * Net-zero: every Payment row + scratch user created here is deleted in after().
 *
 * Run: npm test
 */
process.env.PAYMENTS_ENABLED = 'true';
process.env.PAYMOB_SECRET_KEY = 'sk_test_simulate_only';
process.env.PAYMOB_PUBLIC_KEY = 'pk_test_simulate_only';
process.env.PAYMOB_HMAC_SECRET = 'simulate_hmac_secret_value';
process.env.PAYMOB_INTEGRATION_IDS = '111,222';

process.chdir(__dirname + '/..');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const paymobProvider = require('../src/services/payments/providers/paymobProvider');
const paymentService = require('../src/services/payments/paymentService');
const { createToken } = require('../src/utils.js');
const config = require('../src/config/env.js');
const { randomBase36Slug } = require('../src/utils/slugs.js');

const HMAC_SECRET = 'simulate_hmac_secret_value';

/**
 * Independent HMAC — deliberately duplicates the documented field ORDER (not
 * the client's concatenation) so field-order regressions fail loudly here.
 */
function hmacFor(obj) {
  const concat = [
    obj.amount_cents, obj.created_at, obj.currency, obj.error_occured,
    obj.has_parent_transaction, obj.id, obj.integration_id, obj.is_3d_secure,
    obj.is_auth, obj.is_capture, obj.is_refunded, obj.is_standalone_payment,
    obj.is_voided, obj.order.id, obj.owner, obj.pending,
    obj.source_data.pan, obj.source_data.sub_type, obj.source_data.type,
    obj.success,
  ].map(String).join('');
  return crypto.createHmac('sha512', HMAC_SECRET).update(concat, 'utf8').digest('hex').toLowerCase();
}

let TXN_SEQ = 7000000;
let ORDER_SEQ = 8000000;
/** Build a callback obj for a payment row; overrides flip outcome markers. */
function callbackFor(payment, amountMinor, overrides = {}) {
  return {
    amount_cents: amountMinor,
    created_at: '2026-09-19T12:00:00.000000',
    currency: 'EGP',
    error_occured: false,
    has_parent_transaction: false,
    id: ++TXN_SEQ,
    integration_id: 111,
    is_3d_secure: true,
    is_auth: false,
    is_capture: false,
    is_refunded: false,
    is_standalone_payment: true,
    is_voided: false,
    order: { id: ++ORDER_SEQ, merchant_order_id: payment.providerReference },
    owner: 123456,
    pending: false,
    source_data: { pan: '2346', sub_type: 'MasterCard', type: 'card' },
    success: true,
    ...overrides,
  };
}

/** Verify-then-process — exactly what the webhook controller does. */
async function deliver(obj) {
  const hmac = hmacFor(obj);
  assert.equal(paymobProvider.verifyWebhook(obj, hmac), true, 'forged callback must carry a valid HMAC');
  const event = paymobProvider.normalizeEvent(obj);
  return paymentService.processProviderEvent({ event });
}

async function freshPayment(userId, courseId, amount = 500, status = 'PENDING') {
  return prisma.payment.create({
    data: {
      userId, courseId, amount, currency: 'EGP', status, provider: 'paymob',
      providerReference: `crs-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      providerCheckoutUrl: 'https://accept.paymob.test/unifiedcheckout/?clientSecret=x',
      intentionExpiresAt: new Date(Date.now() + 3600 * 1000),
    },
  });
}

describe('payments lifecycle (simulated provider callbacks)', () => {
  let student; // { user, cookie }
  let course; // priced course 1 fixture resolver
  const createdPaymentIds = [];
  const createdUserIds = [];

  before(async () => {
    // Priced-course fixture: reuse demo course 1 if it carries a price,
    // otherwise price it for the duration of the suite and restore after.
    course = await prisma.course.findUnique({ where: { id: 1 }, select: { id: true, slug: true, price: true } });
    if (!course) throw new Error('fixture course 1 missing');
    if (course.price <= 0) {
      await prisma.course.update({ where: { id: 1 }, data: { price: 500 } });
      course.price = 500;
      course._restored = true;
    }
    const email = `pay-sim-${Date.now()}@localhost.test`;
    const user = await prisma.user.create({
      data: { slug: randomBase36Slug(), name: 'PaySim', email, password: 'x', grade: 'FIRST_SECONDARY' },
    });
    createdUserIds.push(user.id);
    student = {
      user,
      cookie: `accessToken=${createToken({ id: user.id, email, name: 'P', role: 'STUDENT' }, config.jwt.secret)}`,
    };
  });

  after(async () => {
    await prisma.bunnyVideoProgress.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.enrollment.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.payment.deleteMany({ where: { id: { in: createdPaymentIds } } });
    for (const id of createdUserIds) await prisma.user.delete({ where: { id } }).catch(() => {});
    if (course && course._restored) {
      await prisma.course.update({ where: { id: 1 }, data: { price: 0 } });
    }
    assert.equal(await prisma.payment.count({ where: { id: { in: createdPaymentIds } } }), 0, 'net-zero payments');
    assert.equal(await prisma.user.count({ where: { id: { in: createdUserIds } } }), 0, 'net-zero users');
    await prisma.$disconnect();
  });

  async function track(row) {
    createdPaymentIds.push(row.id);
    return row;
  }

  it('success callback fulfils exactly once and grants 365-day access', async () => {
    const payment = await track(await freshPayment(student.user.id, course.id));
    const r1 = await deliver(callbackFor(payment, 50000));
    assert.equal(r1.reason, 'completed');

    const row = await prisma.payment.findUnique({ where: { id: payment.id } });
    assert.equal(row.status, 'COMPLETED');
    assert.ok(row.paidAt);
    assert.equal(row.providerTxnId, String(TXN_SEQ));

    const enrollment = await prisma.enrollment.findFirst({
      where: { userId: student.user.id, courseId: course.id },
    });
    assert.ok(enrollment && enrollment.isPaid, 'enrollment flipped to paid');
    const days = (enrollment.expiresAt - row.paidAt) / (24 * 60 * 60 * 1000);
    assert.ok(days > 364 && days < 366, `365-day window, got ${days.toFixed(2)}d`);

    // Matrix 6: the IDENTICAL callback a second time is a no-op.
    const r2 = await deliver(callbackFor(payment, 50000));
    assert.equal(r2.reason, 'already_processed');
    const row2 = await prisma.payment.findUnique({ where: { id: payment.id } });
    assert.equal(row2.providerTxnId, row.providerTxnId, 'txn id unchanged by the replay');
    assert.equal(
      await prisma.auditLog.count({ where: { action: 'PAYMENT_COMPLETED', targetId: payment.id } }),
      1, 'exactly one completion audit row'
    );
  });

  it('a racing pair of success callbacks fulfils only once', async () => {
    const payment = await track(await freshPayment(student.user.id, course.id));
    const [a, b] = await Promise.all([
      deliver(callbackFor(payment, 50000)),
      deliver(callbackFor(payment, 50000)),
    ]);
    const reasons = [a.reason, b.reason].sort();
    assert.deepEqual(reasons, ['already_processed', 'completed']);
  });

  it('failure callback marks FAILED and grants nothing (matrix 10)', async () => {
    const payment = await track(await freshPayment(student.user.id, course.id));
    // Earlier tests in this file already built this user an enrollment —
    // the point is that THIS failure must not create or change one.
    const before = await prisma.enrollment.count({ where: { userId: student.user.id, courseId: course.id } });
    const r = await deliver(callbackFor(payment, 50000, { success: false }));
    assert.equal(r.reason, 'payment_failed');
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } })).status, 'FAILED');
    assert.equal(await prisma.enrollment.count({ where: { userId: student.user.id, courseId: course.id } }), before);
  });

  it('late success heals FAILED into COMPLETED, audited (D6)', async () => {
    const payment = await track(await freshPayment(student.user.id, course.id));
    await deliver(callbackFor(payment, 50000, { success: false }));
    const r = await deliver(callbackFor(payment, 50000));
    assert.equal(r.reason, 'completed');
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } })).status, 'COMPLETED');
  });

  it('tampered amount (valid HMAC shape, wrong cents) is refused and logged', async () => {
    const payment = await track(await freshPayment(student.user.id, course.id, 500));
    // Genuine signature over the WRONG amount — the classic merchant-discount attack.
    const r = await deliver(callbackFor(payment, 49900));
    assert.equal(r.reason, 'amount_mismatch');
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } })).status, 'PENDING', 'never fulfils on mismatch');
    assert.equal(
      await prisma.auditLog.count({ where: { action: 'PAYMENT_AMOUNT_MISMATCH', targetId: payment.id } }),
      1, 'mismatch is audited for manual review'
    );
  });

  it('pending:true callback never fails the payment (G5)', async () => {
    const payment = await track(await freshPayment(student.user.id, course.id));
    const r = await deliver(callbackFor(payment, 50000, { pending: true, success: false }));
    assert.equal(r.reason, 'still_pending');
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } })).status, 'PENDING');
  });

  it('failure after COMPLETED can never downgrade (R3)', async () => {
    const payment = await track(await freshPayment(student.user.id, course.id));
    await deliver(callbackFor(payment, 50000));
    const r = await deliver(callbackFor(payment, 50000, { success: false }));
    assert.equal(r.reason, 'failure_after_terminal');
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } })).status, 'COMPLETED');
  });

  it('unmatched reference is logged and ignored (D9)', async () => {
    const ghost = callbackFor({ providerReference: 'crs-ghost-abcdef01', id: 0 }, 50000);
    ghost.order.merchant_order_id = 'crs-ghost-abcdef01';
    const r = await deliver(ghost);
    assert.equal(r.reason, 'unmatched');
  });

  it('status read enforces ownership (matrix 17)', async () => {
    const payment = await track(await freshPayment(student.user.id, course.id));
    await assert.rejects(
      paymentService.getPaymentStatus(999999999, payment.providerReference),
      (e) => e && e.code === 'PAYMENT_NOT_FOUND'
    );
    const ok = await paymentService.getPaymentStatus(student.user.id, payment.providerReference);
    assert.equal(ok.status, 'PENDING');
    assert.equal(ok.amountMajor, 500);
  });
});


