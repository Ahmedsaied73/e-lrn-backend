'use strict';

/**
 * Paymob provider — the ONLY module that talks to Paymob (D15).
 *
 * Exposes the provider contract from providers/index.js:
 *   createCheckout() → { providerRef, checkoutUrl, expiresAt, raw }
 *   verifyWebhook(obj, hmac) → boolean
 *   normalizeEvent(verifiedObj) → { type, reference, providerTxnId, amountMinor, currency, raw }
 *   fetchTransaction({ providerTxnId | providerOrderId }) → verified obj (reconciliation only, D11)
 *
 * Money (D3): service amounts are ALWAYS whole EGP; the *100 conversion is
 * buried inside this file right before the HTTP call. No other file multiplies.
 */

const crypto = require('crypto');
const axios = require('axios');
const config = require('../../../config/env');
const { AppError } = require('../../../utils/AppError');

const REQUEST_TIMEOUT_MS = 15000;

// ─── Paymob event taxonomy (what the service layer sees) ────────────────────
const EVENTS = {
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  PENDING: 'pending',
  REFUNDED: 'refunded',
};

function paymobConfig() {
  const cfg = config.paymob;
  if (!cfg || !cfg.enabled || !cfg.configured) {
    throw new AppError('Payments are not available.', 503, 'PAYMENTS_DISABLED');
  }
  return cfg;
}

/**
 * Whole-EGP → piasters. The input is a whole integer, so `*100` is exact —
 * no float enters the path and no rounding exists. Non-integer input is
 * refused outright rather than coerced.
 */
function toMinorUnits(amountMajor) {
  if (!Number.isSafeInteger(amountMajor) || amountMajor <= 0) {
    throw new AppError('Payment amount must be a positive whole-EGP integer.', 400, 'PAYMENT_INVALID_AMOUNT');
  }
  return amountMajor * 100;
}

/**
 * POST /v1/intention/ — create a hosted checkout session.
 *
 * On any throw the caller deletes the orphan PENDING row (matrix 18), so no
 * unreachable-gateway error can strand a checkout.
 */
async function createCheckout({ amountMajor, currency, reference, description, customer, returnUrl, webhookUrl }) {
  const cfg = paymobConfig();
  const amount = toMinorUnits(amountMajor);
  const who = customer || {};

  const body = {
    amount,
    currency: currency || cfg.currency,
    payment_methods: cfg.integrationIds,
    items: [{ name: description, amount, description, quantity: 1 }],
    billing_data: {
      first_name: who.firstName || 'Student',
      last_name: who.lastName || 'Student',
      email: who.email || 'student@example.com',
      // Paymob 400s without a phone number — a placeholder keeps a missing
      // profile phone from blocking checkout (real number preferred).
      phone_number: who.phone || '+201000000000',
      street: 'NA', building: 'NA', floor: 'NA', apartment: 'NA',
      city: 'Cairo', state: 'Cairo', country: 'EGY',
    },
    special_reference: reference,
    extras: { merchant_order_id: reference },
    expiration: cfg.intentionExpirySeconds,
  };
  if (returnUrl) body.redirection_url = returnUrl;
  if (webhookUrl) body.notification_url = webhookUrl;

  let response;
  try {
    response = await axios.post(`${cfg.baseUrl}/v1/intention/`, body, {
      headers: {
        // Paymob requires the literal word "Token", not "Bearer".
        Authorization: `Token ${cfg.secretKey}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true, // map errors ourselves
    });
  } catch (err) {
    throw new AppError(`Payment gateway unreachable: ${err.message}`, 502, 'PAYMOB_UNREACHABLE');
  }

  if (response.status < 200 || response.status >= 300) {
    const detail = response.data && response.data.detail ? response.data.detail : JSON.stringify(response.data || {});
    throw new AppError(`Payment gateway rejected the request (${response.status}).`, 502, 'PAYMOB_INTENTION_FAILED', detail);
  }

  const data = response.data || {};
  if (!data.client_secret) {
    throw new AppError('Payment gateway returned no checkout secret.', 502, 'PAYMOB_INTENTION_FAILED');
  }

  return {
    providerRef: data.id != null ? String(data.id) : null,
    checkoutUrl: buildCheckoutUrl(data.client_secret),
    // Paymob expires the session `expiration` seconds after creation (D4) —
    // stored as intentionExpiresAt for the lazy EXPIRED flip.
    expiresAt: new Date(Date.now() + cfg.intentionExpirySeconds * 1000),
    raw: data,
  };
}

/**
 * Build the Unified Checkout URL. The hosted page collects card data — card
 * numbers never touch our servers (PCI scope stays with Paymob).
 */
function buildCheckoutUrl(clientSecret) {
  const cfg = paymobConfig();
  return `${cfg.baseUrl}/unifiedcheckout/?publicKey=${encodeURIComponent(cfg.publicKey)}&clientSecret=${encodeURIComponent(clientSecret)}`;
}

// ─── Webhook verification ───────────────────────────────────────────────────

/**
 * Verify a Transaction Processed Callback.
 *
 * Per Paymob's docs: concatenate these obj fields IN THIS EXACT ORDER (no
 * separator), HMAC-SHA512 with the HMAC secret, lowercase hex, compare to the
 * `hmac` query parameter with timingSafeEqual. Booleans serialize as literal
 * "true"/"false"; null/undefined fields contribute the empty string.
 */
function verifyWebhook(obj, receivedHmac) {
  const cfg = config.paymob;
  // HMAC verification needs only the secret — available whenever credentials
  // exist, even if the feature flag is currently off.
  if (!obj || typeof obj !== 'object' || !receivedHmac || typeof receivedHmac !== 'string') return false;
  if (!cfg || !cfg.hmacSecret) return false;

  const fields = [
    obj.amount_cents,
    obj.created_at,
    obj.currency,
    obj.error_occured,
    obj.has_parent_transaction,
    obj.id,
    obj.integration_id,
    obj.is_3d_secure,
    obj.is_auth,
    obj.is_capture,
    obj.is_refunded,
    obj.is_standalone_payment,
    obj.is_voided,
    obj.order && obj.order.id,
    obj.owner,
    obj.pending,
    obj.source_data && obj.source_data.pan,
    obj.source_data && obj.source_data.sub_type,
    obj.source_data && obj.source_data.type,
    obj.success,
  ];

  const concatenated = fields.map((v) => (v === null || v === undefined ? '' : String(v))).join('');
  const computed = crypto
    .createHmac('sha512', cfg.hmacSecret)
    .update(concatenated, 'utf8')
    .digest('hex')
    .toLowerCase();

  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(String(receivedHmac).toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Map a VERIFIED callback payload to the provider-agnostic event the service
 * layer consumes. Call verifyWebhook() first — this function trusts its input.
 *
 * Status policy (locked with D6/R2/R3):
 *  - success===true && pending===false && error_occured===false → SUCCEEDED
 *  - refunded/voided markers → REFUNDED
 *  - success===false && pending===false → FAILED
 *  - pending===true (no terminal outcome yet) → PENDING (never auto-fail)
 */
function normalizeEvent(obj, opts = {}) {
  const order = obj && obj.order ? obj.order : {};
  const reference = order.merchant_order_id != null ? String(order.merchant_order_id)
    : (opts.expectedReference != null ? String(opts.expectedReference) : null);
  const providerTxnId = obj && obj.id != null ? String(obj.id) : null;
  const amountMinor = Number.isSafeInteger(obj && obj.amount_cents) ? obj.amount_cents : null;
  const currency = obj && obj.currency ? String(obj.currency) : null;

  let type;
  if (obj.is_refunded === true || obj.is_voided === true) {
    type = EVENTS.REFUNDED;
  } else if (obj.success === true && obj.pending === false && obj.error_occured === false) {
    type = EVENTS.SUCCEEDED;
  } else if (obj.pending === true) {
    // G5 trap: a pending callback is NOT a failure — the money may still
    // settle later (offline/3DS/wallet). Leave the payment PENDING.
    type = EVENTS.PENDING;
  } else {
    type = EVENTS.FAILED;
  }

  return { type, reference, providerTxnId, amountMinor, currency, raw: obj };
}

/**
 * Lookup a transaction on Paymob's side by Paymob order or transaction id —
 * reconciliation backstop only (D11), never a per-callback gate.
 */
async function fetchTransaction({ providerTxnId, providerOrderId }) {
  const cfg = paymobConfig();
  if (!providerTxnId && !providerOrderId) {
    throw new AppError('A provider transaction or order id is required.', 400, 'PAYMENT_LOOKUP_REQUIRED');
  }
  const id = providerTxnId != null ? String(providerTxnId) : String(providerOrderId);
  let response;
  try {
    response = await axios.get(`${cfg.baseUrl}/api/acceptance/transactions/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Token ${cfg.secretKey}` },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });
  } catch (err) {
    throw new AppError(`Payment gateway unreachable: ${err.message}`, 502, 'PAYMOB_UNREACHABLE');
  }
  if (response.status < 200 || response.status >= 300 || !response.data || typeof response.data !== 'object') {
    throw new AppError('Payment gateway lookup failed.', 502, 'PAYMOB_LOOKUP_FAILED');
  }
  return response.data;
}

module.exports = {
  EVENTS,
  toMinorUnits,
  createCheckout,
  buildCheckoutUrl,
  verifyWebhook,
  normalizeEvent,
  fetchTransaction,
};

