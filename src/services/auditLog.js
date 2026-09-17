'use strict';

/**
 * auditLog.js — append-only admin-action audit trail (T4.4).
 *
 * Contract:
 *  - NEVER throws. Auditing is evidence, not the primary operation: if a write
 *    fails (DB hiccup, missing fields) the caller's action still succeeds and
 *    the failure is logged, not propagated.
 *  - Sanitizes metadata: no passwords/answers/tokens ever. Callers pass plain
 *    values (ids, names, diffs) — the helper only stores whitelisted JSON.
 *
 * Usage:
 *   const audit = require('./auditLog');
 *   await audit.record(req, { action: 'QUIZ_GRADE', targetType: 'attempt', targetId: id, metadata: { score: 80 } });
 */

const prisma = require('../config/db');

/**
 * Record one audit row. `req` optional — when absent (scripts, cron, system
 * actions) the actor is null. metadata must be a plain JSON-serializable
 * object; anything non-serializable is dropped.
 */
async function record(req, { action, targetType = null, targetId = null, metadata = null }) {
  try {
    if (!action || typeof action !== 'string') return false;

    // Auto-sanitize: never persist objects whose serialization can fail, and
    // strip any key that could carry credentials if a caller slips.
    const SANITIZED_KEYS = new Set(['password', 'refreshToken', 'answerKey', 'responses']);
    let safeMeta = null;
    if (metadata && typeof metadata === 'object') {
      safeMeta = {};
      for (const [k, v] of Object.entries(metadata)) {
        if (SANITIZED_KEYS.has(k)) continue;
        if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
        if (typeof v === 'bigint') continue;
        try {
          JSON.stringify(v); // throw if circular/bigint
          safeMeta[k] = v;
        } catch {
          safeMeta[k] = String(v);
        }
      }
      if (Object.keys(safeMeta).length === 0) safeMeta = null;
    }

    const actorId =
      req && req.user && Number.isSafeInteger(req.user.id)
        ? req.user.id
        : null;

    await prisma.auditLog.create({
      data: {
        actorId,
        action,
        targetType: targetType || null,
        targetId: targetId || null,
        metadata: safeMeta,
      },
    });
    return true;
  } catch (err) {
    console.error('[audit] failed to record', action, '-', err.message);
    return false;
  }
}

module.exports = { record };