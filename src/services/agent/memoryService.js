'use strict';

/**
 * memoryService.js — cross-conversation memory: per-turn loading + retention (Phase 7,
 * handoff §3.9).
 *
 * The TOOLS live in tools/memory.js; this module owns the two non-tool surfaces:
 * loading the per-turn block the prompt carries, and the retention sweep the daily
 * job calls. Both touch ONLY the AgentMemory table, both scope every query by
 * adminId, and neither is visible to the model — a stored fact is evidence for the
 * answer, never a capability.
 *
 * Injection NEVER WRITES. `updatedAt` is what orders the block (a row edited through
 * forget/remember moves to the front), and a read-only turn leaves the clock alone:
 * bumping it on every read would make the 30-day window unprunable for an admin who
 * simply keeps chatting, and would spend a write per model call.
 */

/** How many rows ride into the prompt (handoff §3.9: start at 50, revisit on crowding). */
const MEMORY_TURN_LIMIT = 50;

/** One tick's lock footprint — same cap as the conversation pruner (its twin). */
const MEMORY_PRUNE_BATCH = 200;

/**
 * Load this admin's facts for the turn, last-touched-first, in the shape the prompt
 * builder takes (plain content strings; blanks dropped). Every query is scoped by the
 * caller's adminId, so one admin's facts can never ride into another admin's prompt.
 */
async function loadMemoriesForTurn({ prisma, adminId, limit = MEMORY_TURN_LIMIT } = {}) {
  if (!prisma || typeof prisma !== 'object') throw new Error('loadMemoriesForTurn: prisma is required');
  if (!Number.isSafeInteger(adminId) || adminId <= 0) throw new Error('loadMemoriesForTurn: adminId is required');
  const take = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MEMORY_TURN_LIMIT) : MEMORY_TURN_LIMIT;
  const rows = await prisma.agentMemory.findMany({
    where: { adminId },
    orderBy: { updatedAt: 'desc' },
    take,
    select: { content: true },
  });
  return rows.map((row) => row.content).filter((content) => typeof content === 'string' && content.trim().length > 0);
}

/**
 * One sweep row-count, for the daily job. Selects doomed ids first, then deletes —
 * the same select-then-delete the conversation pruner uses because Postgres has no
 * DELETE ... LIMIT. Returns { deleted, remaining, disabled }; a DATABASE error is
 * allowed to propagate because the JOB owns the logging and the fail-open policy.
 */
async function pruneExpiredMemories({ prisma, retentionDays, now = new Date() } = {}) {
  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0) {
    return { deleted: 0, remaining: null, disabled: true };
  }
  // The only throw that belongs here is a caller bug (a missing client). Every
  // DATABASE error is allowed to propagate: the job owns the logging, exactly like
  // the conversation pruner this mirrors.
  if (!prisma || typeof prisma !== 'object') throw new Error('pruneExpiredMemories: prisma is required');

  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  // Least-recently-touched first: a partial run drops the coldest facts, never an
  // arbitrary set. MEMORY_PRUNE_BATCH caps one tick's lock footprint.
  const victims = await prisma.agentMemory.findMany({
    where: { updatedAt: { lt: cutoff } },
    orderBy: { updatedAt: 'asc' },
    take: MEMORY_PRUNE_BATCH,
    select: { id: true },
  });
  if (victims.length === 0) return { deleted: 0, remaining: 0, disabled: false };

  const { count } = await prisma.agentMemory.deleteMany({ where: { id: { in: victims.map((row) => row.id) } } });

  let remaining = null;
  try {
    remaining = await prisma.agentMemory.count({ where: { updatedAt: { lt: cutoff } } });
  } catch {
    remaining = null;
  }

  return { deleted: count, remaining, disabled: false };
}

module.exports = {
  MEMORY_TURN_LIMIT,
  loadMemoriesForTurn,
  pruneExpiredMemories,
};