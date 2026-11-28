'use strict';

/**
 * memory.js — the cross-conversation memory tools (Phase 7, handoff §3.9).
 *
 * Three tools, three kinds: `remember_fact` (action: store one fact),
 * `forget_fact` (action: delete one fact by id — the handoff's one deliberate
 * scope addition, because an unretractable memory is a liability), and
 * `list_memories` (read: newest-edit-first, uncached so a forget in the same
 * turn is immediately visible in the same turn).
 *
 * Doctrine inherited from actions.js:
 *  - Prisma only, no raw SQL. Facts are the agent's own words, stored verbatim.
 *  - Every action returns `targetId` so execute() writes a precise audit row.
 *  - Attribution comes from ctx.adminId in _kit.execute() — never from a tool
 *    argument, so a model cannot store a memory for, or read the memories of,
 *    another admin. Every query is scoped by adminId, owner's-row style.
 *  - Memory content is admin-authored-by-proxy (the model phrases it), so the
 *    injection contract already covers it: tool output is DATA, and the prompt's
 *    memory block is labelled as remembered, not live, facts.
 */

const { z } = require('zod');
const { confirmableActionTool, readTool } = require('./_kit');

/**
 * remember_fact — store one fact the agent believes it learned (Phase 7, §3.9).
 *
 * Confirm-gated (Audit #6): prompt injection in student text cannot poison
 * persistent cross-conversation memory without explicit admin confirmation.
 */
const rememberFact = confirmableActionTool({
  name: 'remember_fact',
  description:
    'حفظ معلومة واحدة عن المشرف أو المنصة لاستخدامها في المحادثات القادمة (تفضيل، قرار عمل، حقيقة). يتم على خطوتين: معاينة أولاً ثم تنفيذ بعد تأكيد المشرف الصريح بتوكن المعاينة.',
  schema: z.object({
    content: z.string().min(3).max(500).describe('المعلومة المراد حفظها بصياغتك أنت (٣ إلى ٥٠٠ حرف)'),
  }),
  audit: { action: 'MEMORY_CREATE', targetType: 'agentMemory' },
  preview: async (args) => ({
    ok: true,
    action: 'REMEMBER_FACT',
    content: args.content,
    warning: 'سيتم حفظ هذه المعلومة في ذاكرة المساعد الدائمة بعد تأكيدك.',
  }),
  run: async (args, ctx) => {
    const row = await ctx.prisma.agentMemory.create({
      data: {
        adminId: ctx.adminId,
        content: args.content,
        sourceConversationId: ctx.conversationId,
      },
      select: { id: true, content: true, sourceConversationId: true, createdAt: true },
    });
    return {
      ok: true,
      targetId: row.id,
      memory: { id: row.id, content: row.content, sourceConversationId: row.sourceConversationId },
      createdAtIso: row.createdAt.toISOString(),
    };
  },
});

/**
 * forget_fact — delete one stored fact by its id (Phase 7, §3.9).
 */
const forgetFact = confirmableActionTool({
  name: 'forget_fact',
  description:
    'حذف معلومة محفوظة خاطئة أو قديمة برقمها (تراه في أداة عرض الذكريات). يتم على خطوتين: معاينة أولاً ثم حذف بعد تأكيد المشرف الصريح بتوكن المعاينة.',
  schema: z.object({
    memoryId: z.number().int().positive().describe('رقم المعلومة المراد حذفها'),
  }),
  audit: { action: 'MEMORY_DELETE', targetType: 'agentMemory' },
  preview: async (args, ctx) => {
    const existing = await ctx.prisma.agentMemory.findFirst({
      where: { id: args.memoryId, adminId: ctx.adminId },
      select: { id: true, content: true },
    });
    if (!existing) return { ok: false, reason: 'MEMORY_NOT_FOUND', memoryId: args.memoryId };
    return {
      ok: true,
      action: 'FORGET_FACT',
      memoryId: existing.id,
      content: existing.content,
      warning: 'سيتم حذف هذه المعلومة من الذاكرة الدائمة بعد تأكيدك.',
    };
  },
  run: async (args, ctx) => {
    const existing = await ctx.prisma.agentMemory.findFirst({
      where: { id: args.memoryId, adminId: ctx.adminId },
      select: { id: true, content: true },
    });
    if (!existing) return { ok: false, reason: 'MEMORY_NOT_FOUND', memoryId: args.memoryId };

    await ctx.prisma.agentMemory.delete({ where: { id: existing.id } });
    return { ok: true, targetId: existing.id, memoryId: existing.id, content: existing.content };
  },
});

/**
 * list_memories — read the admin's stored facts, newest-touch first (Phase 7, §3.9).
 *
 * Read-kind, row-capped and uncached (memory changes mid-conversation: the admin may
 * forget a fact and ask what remains in the SAME turn, and a cached answer would lie).
 */
const listMemories = readTool({
  name: 'list_memories',
  description:
    'عرض المعلومات المحفوظة عن المشرف والمنصة من المحادثات السابقة، الأحدث تعديلاً أولاً. يُستخدم عند سؤال «فاكر إيه عني؟» أو قبل الاعتماد على معلومة قديمة. للقراءة فقط ولا يغيّر شيئاً.',
  schema: z.object({
    take: z.number().int().min(1).max(50).optional().describe('عدد المعلومات المعروضة (١ إلى ٥٠، الافتراضي ٢٠)'),
  }),
  cacheTtlSeconds: 0,
  run: async (args, ctx) => {
    const take = Number.isSafeInteger(args.take) && args.take > 0 ? Math.min(args.take, 50) : 20;
    const rows = await ctx.prisma.agentMemory.findMany({
      where: { adminId: ctx.adminId },
      orderBy: { updatedAt: 'desc' },
      take,
      select: { id: true, content: true, sourceConversationId: true, updatedAt: true },
    });
    return {
      memories: rows.map((row) => ({
        id: row.id,
        content: row.content,
        sourceConversationId: row.sourceConversationId,
        updatedAtIso: row.updatedAt.toISOString(),
      })),
    };
  },
});

module.exports = [rememberFact, forgetFact, listMemories];