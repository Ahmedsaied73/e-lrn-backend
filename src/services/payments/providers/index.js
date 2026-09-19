'use strict';

/**
 * Provider registry — the replaceability seam (D15, architecture).
 *
 * Business logic (`paymentService.js`) talks to providers only through the
 * contract below and NEVER imports a concrete provider module directly.
 * A future second provider registers one line here + one file beside
 * paymobProvider.js — nothing else in the codebase changes.
 */
const { AppError } = require('../../../utils/AppError');

const registry = {
  // name → loader (lazy: importing one provider must never load another's deps)
  paymob: () => require('./paymobProvider'),
};

/** Resolve a provider by name. Throws PAYMENT_PROVIDER_UNKNOWN (500) otherwise. */
function getProvider(name) {
  const loader = registry[String(name || '').toLowerCase()];
  if (!loader) {
    throw new AppError(`Unknown payment provider "${name}".`, 500, 'PAYMENT_PROVIDER_UNKNOWN');
  }
  return loader();
}

/** The names the system can ever charge through (for validation + docs). */
function providerNames() {
  return Object.keys(registry);
}

module.exports = { getProvider, providerNames };
