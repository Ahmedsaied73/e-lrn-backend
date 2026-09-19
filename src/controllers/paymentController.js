'use strict';

/**
 * Payment HTTP controllers — thin adapters over paymentService (D15).
 *
 * They do input shaping + response envelopes ONLY: no money math, no provider
 * calls, no state transitions. AppError from the service carries {statusCode,
 * code} into the global handler's envelope.
 *
 * Checkout URLs (returnUrl/webhookUrl) are BUILT HERE from server config —
 * never accepted from the client (matrix 11).
 */
const paymentService = require('../services/payments/paymentService');

/** Absolute server URL for the Paymob notification (webhook) endpoint. */
function publicApiBase() {
  const configured = String(process.env.PUBLIC_API_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  return `http://localhost:${process.env.PORT || 3005}`;
}

/** First configured frontend origin — the browser redirect target. */
function frontendBase() {
  const first = String(process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0].trim();
  return first.replace(/\/+$/, '');
}

/**
 * POST /payments/checkout — body: { courseSlug }.
 * 201 + { checkoutUrl, providerReference, amountMajor, currency, expiresAt, reused }
 * 400 COURSE_IS_FREE · 404 · 409 ALREADY_PAID · 503 PAYMENTS_DISABLED
 */
async function createCheckout(req, res, next) {
  try {
    const { courseSlug } = req.body || {};
    const out = await paymentService.createCourseCheckout(req.user.id, courseSlug, {
      returnUrl: `${frontendBase()}/payment/result`,
      webhookUrl: `${publicApiBase()}/webhooks/paymob`,
    });
    // The student polls with expiresAt even when the provider call succeeded.
    return res.status(201).json({
      success: true,
      data: {
        paymentId: out.paymentId,
        providerReference: out.providerReference,
        amountMajor: out.amountMajor,
        currency: out.currency,
        checkoutUrl: out.checkoutUrl,
        expiresAt: out.expiresAt,
        reused: out.reused,
      },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /payments/status/:providerReference — result-page polling.
 * Ownership is enforced inside the service (matrix 17).
 */
async function getStatus(req, res, next) {
  try {
    const { providerReference } = req.params;
    const status = await paymentService.getPaymentStatus(req.user.id, providerReference);
    return res.status(200).json({ success: true, data: status });
  } catch (err) {
    return next(err);
  }
}

/** GET /payments/history — the student's own payments. */
async function getHistory(req, res, next) {
  try {
    const history = await paymentService.getPaymentHistory(req.user.id);
    return res.status(200).json({ success: true, data: history });
  } catch (err) {
    return next(err);
  }
}

module.exports = { createCheckout, getStatus, getHistory };
