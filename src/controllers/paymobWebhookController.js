'use strict';

/**
 * Paymob webhook controller — POST /webhooks/paymob.
 *
 * Unlike the Bunny webhook, Paymob's HMAC is computed over concatenated
 * FIELD VALUES (not the raw body), so standard express.json() parsing is
 * safe — the route still mounts beside the Bunny webhook (pre-global-parser,
 * webhook-scoped limiter) because Paymob's server-to-server POST carries no
 * Origin and CSRF checks should never run on it.
 *
 * The HMAC arrives as `?hmac=` and is verified INSIDE the provider BEFORE any
 * state change. Status policy (D10):
 *   - service returns/throws for a transient failure → 5xx (Paymob retries);
 *   - everything else → 200, including rejected forgeries (an attacker must
 *     not be able to trigger retry storms) and expected terminal no-ops.
 */
const paymentService = require('../services/payments/paymentService');
const { getProvider } = require('../services/payments/providers/index');

const log = {
  warn: (event, ctx = {}) => console.warn(`[WARN] ${event}`, JSON.stringify(ctx)),
  error: (event, ctx = {}) => console.error(`[ERROR] ${event}`, JSON.stringify(ctx)),
};

/**
 * Body: { type: 'TRANSACTION', obj: { ...transaction } }. Query: ?hmac=<hex>.
 * Anything structurally short of that is a forgery or a probe — 200, no touch.
 */
async function handlePaymobWebhook(req, res, next) {
  try {
    const hmac = req.query && req.query.hmac;
    const obj = req.body && req.body.obj;

    if (!obj || typeof obj !== 'object' || typeof hmac !== 'string') {
      log.warn('paymob.webhook.rejected', { reason: 'malformed', ip: req.ip });
      return res.status(200).json({ received: true });
    }

    let verified;
    try {
      verified = getProvider('paymob').verifyWebhook(obj, hmac);
    } catch (err) {
      // Provider misconfigured mid-flight (keys rotated) — this IS retryable.
      log.error('paymob.webhook.provider_unavailable', { error: String((err && err.message) || err).slice(0, 200) });
      return next(err);
    }
    if (!verified) {
      // Forged/tampered: 200 so an attacker cannot force retry storms.
      log.warn('paymob.webhook.rejected', { reason: 'invalid_hmac', txnId: obj.id, ip: req.ip });
      return res.status(200).json({ received: true });
    }

    let event;
    try {
      event = getProvider('paymob').normalizeEvent(obj);
    } catch (err) {
      // A verified payload we cannot normalize is retryable — losing it could
      // strand a real payment.
      return next(err);
    }

    let result;
    try {
      result = await paymentService.processProviderEvent({ event });
    } catch (err) {
      // Transient/internal failure (DB pool, txn conflict): D10 → 5xx so
      // Paymob retries; the CAS keeps any retry idempotent.
      log.error('paymob.webhook.transient', { reference: event.reference, error: String((err && err.message) || err).slice(0, 300) });
      return next(err);
    }

    return res.status(result.status || 200).json({ received: true });
  } catch (err) {
    // Last-resort guard: unexpected = potentially transient = let the global
    // handler 500, which is itself a retry signal for Paymob.
    return next(err);
  }
}

module.exports = { handlePaymobWebhook };
