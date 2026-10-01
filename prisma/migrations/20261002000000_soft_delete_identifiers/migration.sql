-- Phase 8 (soft delete, decision #19 + Q5): the two identifier columns the delete
-- path needs before it overwrites the live ones.
--
-- WHY THIS IS A SECOND MIGRATION: 20261001000000 shipped User.deletedAt and
-- Course.deletedAt and stated in its own header that "the soft-delete work never
-- needs a second schema change". That statement was wrong for one case — Q5 frees
-- the student's email and phone at delete time so they can register again, which
-- means the ORIGINALS must be parked somewhere before the live columns are
-- overwritten with a tombstone / null. There is nowhere else to put them.
--
-- Both columns are NULLABLE and add no constraint, so every existing row is
-- byte-identical after this runs and no query changes behavior until the Phase 8
-- filters land with it. Like its sibling, this file is NOT applied by the agent
-- (plan rule 2): apply it with the commands in PHASE_8_REPORT.md section 8.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "deletedEmail" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "deletedPhoneNumber" TEXT;
