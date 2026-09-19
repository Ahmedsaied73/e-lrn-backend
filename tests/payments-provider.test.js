'use strict';

/* Provider-layer unit tests — no network, no DB, no server.
 *
 * HMAC verification is THE money-critical control, so these tests prove:
 *   (a) the client agrees with an independently computed HMAC for a fixed
 *       fixture, and (b) tampering ANY single field fails verification.
 *
 * Values below are fictional test secrets. They are assigned BEFORE config is
 * required (env.js reads process.env at load) and node --test isolates this
 * file in its own process, so nothing leaks into other suites.
 *
 * Run: node --test tests/payments-provider.test.js
 */
process.env.PAYMENTS_ENABLED = 'true';
process.env.PAYMOB_SECRET_KEY = 'sk_test_unit_do_not_use';
process.env.PAYMOB_PUBLIC_KEY = 'pk_test_unit_do_not_use';
process.env.PAYMOB_HMAC_SECRET = 'unit_test_hmac_secret_value';
process.env.PAYMOB_INTEGRATION_IDS = '111,222';

process.chdir(__dirname + '/..');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const paymob = require('../src/services/payments/providers/paymobProvider');
const { getProvider, providerNames } = require('../src/services/payments/providers/index');

// A realistic Transaction Processed `obj` shape (Paymob docs, values fictional).
const FIXTURE_OBJ = {
  amount_cents: 50000,
  created_at: '2026-09-19T12:00:00.000000',
  currency: 'EGP',
  error_occured: false,
  has_parent_transaction: false,
  id: 987654321,
  integration_id: 111,
  is_3d_secure: true,
  is_auth: false,
  is_capture: false,
  is_refunded: false,
  is_standalone_payment: true,
  is_voided: false,
  order: { id: 555444333, merchant_order_id: 'crs-7-deadbeef' },
  owner: 123456,
  pending: false,
  source_data: { pan: '2346', sub_type: 'MasterCard', type: 'card' },
  success: true,
};

/**
 * Independent HMAC computation — deliberately NOT importing the client's
 * concatenation, so the test pins the field ORDER, not just round-trip.
 * (Field order mirrors Paymob's documented order; any reordering here must
 * come from a docs change, not a refactor.)
 */
function expectedHmacFor(obj, secret) {
  const concat = [
    obj.amount_cents, obj.created_at, obj.currency, obj.error_occured,
    obj.has_parent_transaction, obj.id, obj.integration_id, obj.is_3d_secure,
    obj.is_auth, obj.is_capture, obj.is_refunded, obj.is_standalone_payment,
    obj.is_voided, obj.order.id, obj.owner, obj.pending,
    obj.source_data.pan, obj.source_data.sub_type, obj.source_data.type,
    obj.success,
  ].map(String).join('');
  return crypto.createHmac('sha512', secret).update(concat, 'utf8').digest('hex').toLowerCase();
}

const SECRET = 'unit_test_hmac_secret_value';

describe('paymobProvider.toMinorUnits', () => {
  it('converts whole EGP to piasters exactly', () => {
    assert.equal(paymob.toMinorUnits(1), 100);
    assert.equal(paymob.toMinorUnits(500), 50000);
  });

  it('refuses non-integer/zero/negative input instead of rounding', () => {
    for (const bad of [0, -1, 1.5, 99.99, NaN, Infinity, '500', null, undefined]) {
      assert.throws(() => paymob.toMinorUnits(bad), (e) => e && e.code === 'PAYMENT_INVALID_AMOUNT', `rejects ${String(bad)}`);
    }
  });
});

describe('paymobProvider.verifyWebhook', () => {
  it('accepts a fixture with the independently computed HMAC', () => {
    const hmac = expectedHmacFor(FIXTURE_OBJ, SECRET);
    assert.equal(paymob.verifyWebhook(FIXTURE_OBJ, hmac), true);
  });

  it('rejects tampering of ANY single field', () => {
    const hmac = expectedHmacFor(FIXTURE_OBJ, SECRET);
    const tamperCases = [
      (o) => { o.amount_cents = 50001; },
      (o) => { o.success = false; },
      (o) => { o.pending = true; },
      (o) => { o.is_refunded = true; },
      (o) => { o.is_voided = true; },
      (o) => { o.error_occured = true; },
      (o) => { o.id = 1; },
      (o) => { o.integration_id = 222; },
      (o) => { o.order.id = 1; },
      (o) => { o.owner = 1; },
      (o) => { o.currency = 'USD'; },
      (o) => { o.created_at = '2026-01-01T00:00:00.000000'; },
      (o) => { o.source_data.pan = '9999'; },
      (o) => { o.source_data.sub_type = 'Visa'; },
      (o) => { o.source_data.type = 'wallet'; },
      (o) => { o.is_3d_secure = false; },
      (o) => { o.is_auth = true; },
      (o) => { o.is_capture = true; },
      (o) => { o.is_standalone_payment = false; },
      (o) => { o.has_parent_transaction = true; },
    ];
    assert.equal(tamperCases.length, 20, 'every HMAC field is covered');
    for (const tamper of tamperCases) {
      const copy = JSON.parse(JSON.stringify(FIXTURE_OBJ));
      tamper(copy);
      assert.equal(paymob.verifyWebhook(copy, hmac), false, 'tampered field must fail');
    }
  });

  it('rejects malformed inputs without throwing', () => {
    const hmac = expectedHmacFor(FIXTURE_OBJ, SECRET);
    assert.equal(paymob.verifyWebhook(null, hmac), false);
    assert.equal(paymob.verifyWebhook(FIXTURE_OBJ, null), false);
    assert.equal(paymob.verifyWebhook(FIXTURE_OBJ, 12345), false);
    assert.equal(paymob.verifyWebhook(FIXTURE_OBJ, 'deadbeef'), false);
    assert.equal(paymob.verifyWebhook(FIXTURE_OBJ, hmac.toUpperCase()), true, 'case-insensitive compare');
  });
});

describe('paymobProvider.normalizeEvent', () => {
  it('maps success/failure/pending/refund markers to service events', () => {
    assert.equal(paymob.normalizeEvent({ ...FIXTURE_OBJ }).type, 'succeeded');
    assert.equal(paymob.normalizeEvent({ ...FIXTURE_OBJ, success: false }).type, 'failed');
    // G5: pending is NEVER a failure.
    assert.equal(paymob.normalizeEvent({ ...FIXTURE_OBJ, pending: true }).type, 'pending');
    assert.equal(paymob.normalizeEvent({ ...FIXTURE_OBJ, success: false, pending: true }).type, 'pending');
    assert.equal(paymob.normalizeEvent({ ...FIXTURE_OBJ, is_refunded: true }).type, 'refunded');
    assert.equal(paymob.normalizeEvent({ ...FIXTURE_OBJ, is_voided: true }).type, 'refunded');
  });

  it('correlates our reference + the provider transaction id', () => {
    const ev = paymob.normalizeEvent(FIXTURE_OBJ);
    assert.equal(ev.reference, 'crs-7-deadbeef');
    assert.equal(ev.providerTxnId, '987654321');
    assert.equal(ev.amountMinor, 50000);
    assert.equal(ev.currency, 'EGP');
  });
});

describe('provider registry', () => {
  it('resolves paymob and only paymob', () => {
    assert.deepEqual(providerNames(), ['paymob']);
    const p = getProvider('paymob');
    for (const fn of ['createCheckout', 'verifyWebhook', 'normalizeEvent', 'fetchTransaction']) {
      assert.equal(typeof p[fn], 'function', `paymob exposes ${fn}`);
    }
  });

  it('rejects unknown providers with a stable code', () => {
    assert.throws(() => getProvider('stripe'), (e) => e && e.code === 'PAYMENT_PROVIDER_UNKNOWN');
    assert.throws(() => getProvider(''), (e) => e && e.code === 'PAYMENT_PROVIDER_UNKNOWN');
  });
});

