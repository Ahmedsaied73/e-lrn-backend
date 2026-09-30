-- Agent v2 rebuild (Phase 7, handoff 3.6 + 3.9): cross-conversation memory rows, and
-- the soft-delete columns Phase 8's `run()` rewrites will use.
--
-- Applied by hand (`prisma db execute --file` + `migrate resolve --applied`)
-- because the shared staging database is reached through a connection pooler
-- with no shadow database available, which `migrate dev` requires to diff. The
-- SQL below is what `migrate dev` would have generated for the matching
-- schema.prisma change (same table/constraint/index naming conventions as the
-- 20260925120000_agent_conversations migration).
--
-- Nothing in here deletes or renames: the new columns are nullable, the new
-- table is empty, and every index is a plain CREATE INDEX, so existing rows are
-- byte-identical after the migration. The soft-delete FILTERS are Phase 8's job;
-- no query may start excluding rows until those filters land with it.

-- CreateTable
CREATE TABLE "AgentMemory" (
    "id" SERIAL NOT NULL,
    "adminId" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "sourceConversationId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentMemory_adminId_updatedAt_idx" ON "AgentMemory"("adminId", "updatedAt" DESC);

-- AddForeignKey
ALTER TABLE "AgentMemory" ADD CONSTRAINT "AgentMemory_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMemory" ADD CONSTRAINT "AgentMemory_sourceConversationId_fkey" FOREIGN KEY ("sourceConversationId") REFERENCES "AgentConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable (soft-delete column, Phase 8's filters — not this migration's)
ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");

-- AlterTable (soft-delete column, Phase 8's filters — not this migration's)
ALTER TABLE "Course" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Course_deletedAt_idx" ON "Course"("deletedAt");
