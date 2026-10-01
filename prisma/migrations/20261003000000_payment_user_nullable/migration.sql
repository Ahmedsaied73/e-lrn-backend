-- Phase 8 (soft delete, decision D1 — owner ruling): a payment record is a FINANCIAL
-- RECORD and must SURVIVE the permanent deletion of the student who made it.
--
-- WHY THIS IS A THIRD MIGRATION: `Payment.userId` was a required FK. That made
-- "purge the user after 30 days" and "retain their payment rows" mutually exclusive —
-- Postgres would have refused the DELETE (or Prisma would have cascaded the payments
-- away, which is exactly what D1 forbids). Dropping NOT NULL lets the purge job null
-- the FK and keep the row: amount, currency, providerReference, providerTxnId,
-- intentionExpiresAt, failureReason, rawEvent and every timestamp stay intact and
-- attributable to a timestamped deletion rather than being destroyed.
--
-- Note `Payment.courseId` is ALREADY nullable (it is `Course?` in the schema), so the
-- course half of D1 needed no schema change — deleting a course already nulls it.
--
-- Additive and nullable-only: existing rows are byte-identical, no query changes
-- shape, and the payments module only ever reads `userId` from rows that have one.
-- NOT applied by the agent (plan rule 2); commands are in PHASE_8_REPORT.md §8.

-- AlterTable
ALTER TABLE "Payment" ALTER COLUMN "userId" DROP NOT NULL;
