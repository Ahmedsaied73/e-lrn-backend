'use strict';

/**
 * Admin payments surface (P2, D9).
 *
 * Logs alone are not enough to ACT on a mismatch/duplicate charge — this is
 * the minimum read-only list an admin needs to triage. No mutation endpoints:
 * refunds stay manual in the Paymob dashboard (D8).
 *
 * Leak rule: never serializes provider secrets or raw callback payloads —
 * providerTxnId/reference are the correlation handles an admin needs.
 */
const prisma = require('../config/db');

const ALLOWED_STATUSES = ['PENDING', 'COMPLETED', 'FAILED', 'EXPIRED', 'REFUNDED'];

/**
 * GET /admin/payments?status=&courseSlug=&search=&page=&limit=
 * Correctly clamps pagination (repo convention: take ∈ [1,100]).
 */
async function listAllPayments(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limitRaw = parseInt(req.query.limit, 10) || 20;
    const take = Math.max(1, Math.min(limitRaw, 100));
    const skip = (page - 1) * take;

    const where = {};
    const status = String(req.query.status || '').trim().toUpperCase();
    if (status) {
      if (!ALLOWED_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, error: 'Invalid status filter.' });
      }
      where.status = status;
    }

    const courseSlug = String(req.query.courseSlug || '').trim();
    if (courseSlug) where.course = { slug: courseSlug };

    // Free-text: student email, or our/provider correlation ids.
    const search = String(req.query.search || '').trim();
    if (search) {
      where.OR = [
        { providerReference: { contains: search, mode: 'insensitive' } },
        { providerTxnId: { contains: search, mode: 'insensitive' } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [total, rows] = await Promise.all([
      prisma.payment.count({ where }),
      prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: {
          id: true, status: true, amount: true, currency: true, provider: true,
          providerReference: true, providerTxnId: true, failureReason: true,
          paidAt: true, refundedAt: true, createdAt: true, intentionExpiresAt: true,
          user: { select: { email: true, name: true, slug: true } },
          course: { select: { slug: true, title: true } },
        },
      }),
    ]);

    return res.status(200).json({
      success: true,
      data: rows.map((p) => ({
        id: p.id,
        status: p.status,
        amountMajor: p.amount,
        currency: p.currency,
        provider: p.provider,
        providerReference: p.providerReference,
        providerTxnId: p.providerTxnId,
        failureReason: p.failureReason,
        paidAt: p.paidAt,
        refundedAt: p.refundedAt,
        createdAt: p.createdAt,
        intentionExpiresAt: p.intentionExpiresAt,
        student: p.user ? { email: p.user.email, name: p.user.name, slug: p.user.slug } : null,
        course: p.course,
      })),
      meta: { total, page, limit: take, totalPages: Math.max(1, Math.ceil(total / take)) },
    });
  } catch (error) {
    console.error('Admin Payments Error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
}

module.exports = { listAllPayments };