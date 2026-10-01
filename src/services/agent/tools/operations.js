'use strict';

/**
 * operations.js — platform-operations reads (notifications + the audit trail).
 *
 * Written directly by the lead engineer: the read-tool team run hit its model
 * quota before reaching this file, so the two remaining tools live here.
 */

const { z } = require('zod');
const { readTool, clampTake, daysAgo } = require('./_kit');

// Audit metadata is evidence, not content. Only these scalar keys are surfaced,
// and the whole summary is truncated: raw metadata can carry free text and
// addresses, and dumping it into a model context is both a privacy and a
// context-economy mistake.
const SAFE_META_KEYS = ['before', 'after', 'detail', 'reason', 'userId', 'courseId', 'slug', 'fields'];
const META_SUMMARY_MAX = 300;

function summarizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return { keys: [], summary: null };
  const keys = Object.keys(metadata).slice(0, 8);
  const parts = [];
  for (const key of SAFE_META_KEYS) {
    const value = metadata[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue; // objects are summarized by their keys only
    parts.push(`${key}=${String(value)}`);
  }
  const summary = parts.join(', ').slice(0, META_SUMMARY_MAX);
  return { keys, summary: summary || null };
}

const notificationStats = readTool({
  name: 'notification_stats',
  description:
    'إحصائيات إشعارات المنصة خلال نافذة زمنية: العدد حسب النوع (تصحيح اختبار، فيديو جاهز، بث إداري)، والمقروء مقابل غير المقروء، وعدد دفعات البث وأكثرها استقبالاً. تُستخدم عند السؤال عن الإشعارات أو وصول الرسائل للطلاب.',
  schema: z.object({
    windowDays: z.number().int().min(1).max(365).optional().describe('عدد الأيام للخلف، افتراضياً ٧'),
    take: z.number().int().min(1).max(25).optional().describe('عدد دفعات البث المعروضة، افتراضياً ١٠'),
  }),
  cacheTtlSeconds: 30,
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const since = daysAgo(args.windowDays);
    const take = clampTake(args.take, 10);

    const [byTypeRaw, readCount, unreadCount, batchGroups] = await Promise.all([
      prisma.notification.groupBy({
        by: ['type'],
        _count: { _all: true },
        where: { createdAt: { gte: since } },
      }),
      prisma.notification.count({ where: { createdAt: { gte: since }, read: true } }),
      prisma.notification.count({ where: { createdAt: { gte: since }, read: false } }),
      prisma.notification.groupBy({
        by: ['batchId'],
        _count: { batchId: true },
        where: { createdAt: { gte: since }, batchId: { not: null } },
        orderBy: { _count: { batchId: 'desc' } },
        take: take + 1,
      }),
    ]);

    const byType = {};
    for (const row of byTypeRaw) byType[row.type] = row._count._all;

    const batches = batchGroups.slice(0, take).map((row) => ({
      batchId: row.batchId,
      recipients: row._count.batchId,
    }));

    return {
      windowDays: Number(args.windowDays),
      sinceIso: since.toISOString(),
      byType,
      totalInWindow: Object.values(byType).reduce((sum, n) => sum + n, 0),
      read: readCount,
      unread: unreadCount,
      batchCount: batches.length,
      topBatches: {
        rows: batches,
        returned: batches.length,
        truncated: batchGroups.length > take,
      },
    };
  },
});

const adminAuditRecent = readTool({
  name: 'admin_audit_recent',
  description:
    'أحدث العمليات الإدارية المسجّلة في سجل التدقيق خلال نافذة زمنية، مع إمكانية التصفية بنوع العملية أو نوع الهدف (مثال: USER_UPDATE أو enrollment أو course). تُستخدم عند السؤال «مين عمل إيه» أو لمراجعة التغييرات الأخيرة. لا تعيد القيم الكاملة للبيانات الوصفية، بل مفاتيحها وملخصاً مختصراً.',
  schema: z.object({
    action: z.string().min(3).max(64).optional().describe('نوع العملية بالضبط، مثل USER_UPDATE'),
    targetType: z.string().min(3).max(32).optional().describe('نوع الهدف، مثل course أو enrollment'),
    windowDays: z.number().int().min(1).max(365).optional().describe('عدد الأيام للخلف، افتراضياً ٧'),
    take: z.number().int().min(1).max(50).optional().describe('عدد الصفوف، افتراضياً ٢٥'),
  }),
  cacheTtlSeconds: 15,
  run: async (args, ctx) => {
    const prisma = ctx.prisma;
    const since = daysAgo(args.windowDays);
    const take = clampTake(args.take, 25);

    const where = { createdAt: { gte: since } };
    if (args.action) where.action = args.action;
    if (args.targetType) where.targetType = args.targetType;

    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      select: {
        id: true,
        action: true,
        actorId: true,
        targetType: true,
        targetId: true,
        metadata: true,
        createdAt: true,
      },
    });

    const page = rows.slice(0, take).map((row) => {
      const { keys, summary } = summarizeMetadata(row.metadata);
      return {
        id: row.id,
        action: row.action,
        actorId: row.actorId,
        targetType: row.targetType,
        targetId: row.targetId,
        metadataKeys: keys,
        metadataSummary: summary,
        createdAtIso: row.createdAt.toISOString(),
      };
    });

    return {
      windowDays: Number(args.windowDays),
      sinceIso: since.toISOString(),
      filters: { action: args.action || null, targetType: args.targetType || null },
      rows: page,
      returned: page.length,
      truncated: rows.length > take,
    };
  },
});

module.exports = [notificationStats, adminAuditRecent];
