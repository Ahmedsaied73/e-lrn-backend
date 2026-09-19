'use strict';

/**
 * paymentService.js — course-purchase business logic (provider-agnostic).
 *
 * Depends on the provider contract from providers/index.js ONLY: it never
 * references Paymob field names, endpoints, or secrets. State changes are
 * driven by events {type, reference, providerTxnId, amountMinor, currency,
 * raw} — never by a client.
 *
 * Entry points: createCourseCheckout() → PENDING + hosted URL (T3a/1a);
 * processProviderEvent() → verified-event fulfillment (T3a/2a);
 * getPaymentStatus()/getPaymentHistory() → result page + history.
 */

const crypto = require('crypto');
const prisma = require('../../config/db');
const config = require('../../config/env');
const cache = require('../../integrations/redis/cache');
const audit = require('../auditLog');
const { getProvider } = require('./providers/index');
const { AppError } = require('../../utils/AppError');
const { isValidSlug } = require('../../utils/slugs');

// 1-year access window from purchase (D2). No cron: the gate compares dates.
const ACCESS_WINDOW_DAYS = 365;

const log = {
  info: (event, ctx = {}) => console.log(`[INFO] ${event}`, JSON.stringify(ctx)),
  warn: (event, ctx = {}) => console.warn(`[WARN] ${event}`, JSON.stringify(ctx)),
  error: (event, ctx = {}) => console.error(`[ERROR] ${event}`, JSON.stringify(ctx)),
};

function paymentsOn() {
  return Boolean(config.features && config.features.payments && config.paymob && config.paymob.enabled);
}

function requirePaymentsOn() {
  if (!paymentsOn()) {
    throw new AppError('Payments are not available.', 503, 'PAYMENTS_DISABLED');
  }
}

/** Whole-EGP course price validation (D3): integer, non-negative. */
function assertPriceMajor(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError('Course price is misconfigured.', 500, 'COURSE_PRICE_INVALID');
  }
  return value;
}

/** Unpredictable correlation id (64-bit random suffix); status reads are also ownership-checked. */
function buildProviderReference(paymentId) {
  return `crs-${paymentId}-${crypto.randomBytes(8).toString('hex')}`;
}

/** Redact card/owner PII from a stored raw event (D8b). */
function redactEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const copy = JSON.parse(JSON.stringify(raw));
  if (copy.source_data && typeof copy.source_data === 'object' && 'pan' in copy.source_data) {
    copy.source_data.pan = '[redacted]';
  }
  if ('owner' in copy) copy.owner = '[redacted]';
  return copy;
}

/**
 * Lazy expiry flip (D4): a PENDING payment whose hosted session outlived
 * intentionExpiresAt becomes EXPIRED. Called on every customer-visible read
 * path — no cron needed. Returns the (possibly re-read) payment.
 */
async function expireIfStale(payment) {
  if (!payment || payment.status !== 'PENDING') return payment;
  if (!payment.intentionExpiresAt || payment.intentionExpiresAt > new Date()) return payment;
  const flipped = await prisma.payment.updateMany({
    where: { id: payment.id, status: 'PENDING' },
    data: { status: 'EXPIRED', failureReason: 'Checkout session expired before payment.' },
  });
  if (flipped.count === 0) {
    // A racing callback already claimed it — reread to report the truth.
    return prisma.payment.findUnique({ where: { id: payment.id } });
  }
  log.info('payments.expired', { paymentId: payment.id });
  return prisma.payment.findUnique({ where: { id: payment.id } });
}

/**
 * Start (or resume) a checkout for a course.
 *
 * @param {number} userId
 * @param {string} courseSlug
 * @param {object} urls - { returnUrl, webhookUrl } (server-built by the controller)
 */
async function createCourseCheckout(userId, courseSlug, urls = {}) {
  requirePaymentsOn();
  if (!isValidSlug(courseSlug)) throw new AppError('Course slug is required.', 400, 'INVALID_SLUG');

  const course = await prisma.course.findUnique({
    where: { slug: courseSlug },
    select: { id: true, slug: true, title: true, price: true },
  });
  if (!course) throw new AppError('Course not found.', 404, 'COURSE_NOT_FOUND');

  const priceMajor = assertPriceMajor(course.price);
  if (priceMajor <= 0) {
    throw new AppError('This course is free — enroll directly instead of paying.', 400, 'COURSE_IS_FREE');
  }

  // Already paid AND unexpired → nothing to buy (D6g). Expired access MAY buy again.
  const paidEnrollment = await prisma.enrollment.findFirst({
    where: { userId, courseId: course.id, isPaid: true },
    select: { id: true, expiresAt: true },
  });
  if (paidEnrollment && (!paidEnrollment.expiresAt || paidEnrollment.expiresAt > new Date())) {
    throw new AppError('You already have access to this course.', 409, 'ALREADY_PAID');
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, phoneNumber: true },
  });
  if (!user) throw new AppError('User not found.', 404, 'USER_NOT_FOUND');

  // D5: one open checkout — reuse a live PENDING payment's URL. A racing
  // terminal event may land between read and reuse; expireIfStale re-reads.
  const open = await prisma.payment.findFirst({
    where: { userId, courseId: course.id, status: 'PENDING', provider: 'paymob' },
    orderBy: { createdAt: 'desc' },
  });
  if (open) {
    const live = await expireIfStale(open);
    if (live && live.status === 'PENDING' && live.providerCheckoutUrl) {
      return {
        paymentId: live.id,
        providerReference: live.providerReference,
        amountMajor: live.amount,
        currency: live.currency,
        checkoutUrl: live.providerCheckoutUrl,
        expiresAt: live.intentionExpiresAt,
        reused: true,
      };
    }
  }

  // The PENDING row is created first so its id anchors the provider reference.
  let payment = await prisma.payment.create({
    data: {
      userId, courseId: course.id, amount: priceMajor,
      currency: config.paymob.currency, status: 'PENDING', provider: 'paymob',
    },
  });
  const providerReference = buildProviderReference(payment.id);

  let checkout;
  try {
    const names = String(user.name || 'Student').trim().split(/\s+/);
    checkout = await getProvider('paymob').createCheckout({
      amountMajor: priceMajor,
      currency: payment.currency,
      reference: providerReference,
      description: course.title,
      customer: {
        firstName: names[0] || 'Student',
        lastName: names.slice(1).join(' ') || 'Student',
        email: user.email,
        phone: user.phoneNumber || null,
      },
      returnUrl: urls.returnUrl,
      webhookUrl: urls.webhookUrl,
    });
  } catch (err) {
    // Matrix 18: never strand an orphan PENDING row on gateway failure.
    await prisma.payment.delete({ where: { id: payment.id } }).catch(() => {});
    throw err;
  }

  payment = await prisma.payment.update({
    where: { id: payment.id },
    data: {
      providerReference,
      providerCheckoutUrl: checkout.checkoutUrl,
      intentionExpiresAt: checkout.expiresAt,
    },
  });

  log.info('payments.checkout.created', { paymentId: payment.id, userId, courseId: course.id, amount: priceMajor });

  return {
    paymentId: payment.id,
    providerReference,
    amountMajor: priceMajor,
    currency: payment.currency,
    checkoutUrl: checkout.checkoutUrl,
    expiresAt: payment.intentionExpiresAt,
    reused: false,
  };
}

/**
 * Handle one VERIFIED provider event. THE ONLY path that grants paid access
 * (D10/D16) — the redirect is never trusted, and the service never accepts a
 * status from a client.
 *
 * Locked policy (D6/R2/R3):
 *  - 'succeeded' → PENDING, FAILED, or EXPIRED rows may fulfil. COMPLETED /
 *    REFUNDED are sticky: later successes are idempotent no-ops.
 *  - 'failed' → PENDING rows become FAILED. Terminal rows keep their state —
 *    a failure callback NEVER downgrades a COMPLETED row (R3).
 *  - 'pending' → no state change (G5). Row stays PENDING for a later terminal
 *    event (or the lazy EXPIRED flip).
 *  - 'refunded' → COMPLETED rows become REFUNDED + access revoked (R1).
 *
 * Fulfilment re-checks the amount in MINOR units against the row (matrix 8):
 * a genuine-but-mismatched event is logged, audited, and refused.
 */
async function processProviderEvent({ event }) {
  if (!event || typeof event !== 'object' || !event.type) {
    return { handled: false, reason: 'malformed', status: 200 };
  }
  if (!paymentsOn()) {
    log.warn('payments.event.ignored', { reason: 'payments_disabled' });
    return { handled: false, reason: 'payments_disabled', status: 200 };
  }

  let payment = null;
  if (event.reference) {
    payment = await prisma.payment.findUnique({ where: { providerReference: event.reference } });
  }
  if (!payment && event.providerTxnId) {
    payment = await prisma.payment.findFirst({ where: { providerTxnId: event.providerTxnId } });
  }
  if (!payment) {
    // Genuine event for an unknown order: log for manual review (D9), never
    // fabricate a row.
    log.warn('payments.event.unmatched', { reference: event.reference || null, providerTxnId: event.providerTxnId || null });
    return { handled: false, reason: 'unmatched', status: 200 };
  }

  if (event.type === 'pending') {
    await prisma.payment.updateMany({
      where: { id: payment.id, status: 'PENDING' },
      data: { rawEvent: redactEvent(event.raw) },
    });
    return { handled: true, reason: 'still_pending', status: 200 };
  }

  if (event.type === 'refunded') {
    return refundPayment(payment, { providerTxnId: event.providerTxnId, raw: event.raw });
  }

  if (event.type === 'failed') {
    const marked = await prisma.payment.updateMany({
      where: { id: payment.id, status: 'PENDING' },
      data: {
        status: 'FAILED',
        failureReason: 'Provider reported a failed transaction.',
        providerTxnId: event.providerTxnId || payment.providerTxnId,
        rawEvent: redactEvent(event.raw),
      },
    });
    if (marked.count === 0) {
      log.info('payments.event.failure_ignored_terminal', { paymentId: payment.id, status: payment.status });
      return { handled: true, reason: 'failure_after_terminal', status: 200 };
    }
    log.info('payments.event.failed', { paymentId: payment.id, providerTxnId: event.providerTxnId });
    return { handled: true, reason: 'payment_failed', status: 200 };
  }

  if (event.type !== 'succeeded') {
    log.warn('payments.event.unknown_type', { paymentId: payment.id, type: event.type });
    return { handled: false, reason: 'unknown_event_type', status: 200 };
  }

  // Amount proof in MINOR units against the row (matrix 8 — never fulfil on a
  // mismatch, but the event is genuine so it is surfaced, not swallowed).
  const expectedMinor = Number.isSafeInteger(payment.amount) ? payment.amount * 100 : null;
  if (!Number.isSafeInteger(event.amountMinor) || event.amountMinor !== expectedMinor) {
    log.error('payments.event.amount_mismatch', { paymentId: payment.id, expected: expectedMinor, got: event.amountMinor });
    await audit.record(null, {
      action: 'PAYMENT_AMOUNT_MISMATCH',
      targetType: 'payment', targetId: payment.id,
      metadata: { userId: payment.userId, courseId: payment.courseId, expectedMinor, got: event.amountMinor },
    });
    return { handled: false, reason: 'amount_mismatch', status: 200 };
  }

  // Atomic fulfilment: compare-and-set on PENDING/FAILED/EXPIRED (matrix 6/7 —
  // a racing duplicate loses the CAS and becomes an idempotent no-op). The
  // providerTxnId UNIQUE constraint is the structural backstop (D12).
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.payment.updateMany({
      where: { id: payment.id, status: { in: ['PENDING', 'FAILED', 'EXPIRED'] } },
      data: {
        status: 'COMPLETED',
        paidAt: now,
        failureReason: null,
        providerTxnId: event.providerTxnId,
        rawEvent: redactEvent(event.raw),
      },
    });
    if (claimed.count === 0) return { claimed: false };

    const expiresAt = new Date(now.getTime() + ACCESS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    await tx.enrollment.upsert({
      where: { userId_courseId: { userId: payment.userId, courseId: payment.courseId } },
      create: {
        userId: payment.userId, courseId: payment.courseId, isPaid: true,
        paymentDate: now, expiresAt, startedAt: now, lastAccess: now,
      },
      update: { isPaid: true, paymentDate: now, expiresAt },
    });
    return { claimed: true, expiresAt };
  });

  if (!result.claimed) {
    return { handled: true, reason: 'already_processed', status: 200 };
  }

  // Post-commit side effects are best-effort — the 200 is already safe to send.
  try {
    const quizService = require('../quizService');
    await quizService.invalidateGateForUser(payment.userId);
  } catch (err) {
    log.warn('payments.event.gate_invalidate_failed', { paymentId: payment.id, error: String(err && err.message).slice(0, 200) });
  }
  try {
    await cache.del(cache.buildKey('courses', 'byid', payment.courseId, `u${payment.userId}`));
  } catch {
    log.warn('payments.event.cache_invalidate_failed', { paymentId: payment.id });
  }
  await audit.record(null, {
    action: 'PAYMENT_COMPLETED',
    targetType: 'payment', targetId: payment.id,
    metadata: { userId: payment.userId, courseId: payment.courseId, amount: payment.amount, providerTxnId: event.providerTxnId },
  });

  log.info('payments.event.completed', { paymentId: payment.id, userId: payment.userId, courseId: payment.courseId });
  return { handled: true, reason: 'completed', status: 200 };
}

/**
 * Refund path (R1): a VERIFIED refund event for a COMPLETED payment revokes
 * access — sets REFUNDED + isPaid=false + expiresAt=now (immediate lockout).
 * Applied inside one transaction with the same CAS discipline; a refund for a
 * row that is already REFUNDED (or never COMPLETED) is a logged no-op.
 */
async function refundPayment(payment, { providerTxnId, raw } = {}) {
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.payment.updateMany({
      where: { id: payment.id, status: 'COMPLETED' },
      data: {
        status: 'REFUNDED', refundedAt: now,
        providerTxnId: providerTxnId || payment.providerTxnId,
        rawEvent: redactEvent(raw),
      },
    });
    if (claimed.count === 0) return { claimed: false };
    await tx.enrollment.updateMany({
      where: { userId: payment.userId, courseId: payment.courseId, isPaid: true },
      data: { isPaid: false, expiresAt: now },
    });
    return { claimed: true };
  });

  if (!result.claimed) {
    log.info('payments.event.refund_ignored', { paymentId: payment.id, status: payment.status });
    return { handled: true, reason: 'refund_no_completed_payment', status: 200 };
  }

  try {
    const quizService = require('../quizService');
    await quizService.invalidateGateForUser(payment.userId);
  } catch (err) {
    log.warn('payments.event.gate_invalidate_failed', { paymentId: payment.id, error: String(err && err.message).slice(0, 200) });
  }
  await audit.record(null, {
    action: 'PAYMENT_REFUNDED',
    targetType: 'payment', targetId: payment.id,
    metadata: { userId: payment.userId, courseId: payment.courseId, providerTxnId: providerTxnId || null },
  });
  log.info('payments.event.refunded', { paymentId: payment.id, userId: payment.userId, courseId: payment.courseId });
  return { handled: true, reason: 'refunded', status: 200 };
}

/**
 * Status read for the result page. Ownership is enforced — a student can only
 * poll their own payment. Every successful read flips stale PENDING rows, so
 * the result page converges without a cron (D4).
 */
async function getPaymentStatus(userId, providerReference) {
  const found = await prisma.payment.findUnique({
    where: { providerReference },
    select: { id: true, userId: true, courseId: true, status: true, amount: true, currency: true, paidAt: true, intentionExpiresAt: true, course: { select: { slug: true, title: true } } },
  });
  if (!found || found.userId !== userId) {
    throw new AppError('Payment not found.', 404, 'PAYMENT_NOT_FOUND');
  }
  const payment = await expireIfStale(found);
  let enrolled = false;
  if (payment.status === 'COMPLETED' && payment.courseId) {
    const enrollment = await prisma.enrollment.findFirst({
      where: { userId, courseId: payment.courseId, isPaid: true },
      select: { id: true, expiresAt: true },
    });
    enrolled = Boolean(enrollment && (!enrollment.expiresAt || enrollment.expiresAt > new Date()));
  }
  return {
    status: payment.status,
    paid: payment.status === 'COMPLETED',
    enrolled,
    amountMajor: payment.amount,
    currency: payment.currency,
    paidAt: payment.paidAt,
    course: payment.course,
  };
}

/** User-facing payment history — no provider internals, no other user's rows. */
async function getPaymentHistory(userId) {
  const payments = await prisma.payment.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, status: true, amount: true, currency: true, provider: true,
      providerReference: true, paidAt: true, createdAt: true,
      course: { select: { slug: true, title: true } },
    },
  });
  return payments.map((p) => ({
    id: p.id, status: p.status, amountMajor: p.amount, currency: p.currency,
    provider: p.provider, providerReference: p.providerReference, paidAt: p.paidAt,
    createdAt: p.createdAt, course: p.course,
  }));
}

module.exports = {
  paymentsOn,
  createCourseCheckout,
  processProviderEvent,
  expireIfStale,
  getPaymentStatus,
  getPaymentHistory,
  ACCESS_WINDOW_DAYS,
};




