-- Drop unused password-reset columns (feature reverted in 52a367c). No code reads or writes these columns.
ALTER TABLE "User" DROP COLUMN IF EXISTS "passwordResetToken", DROP COLUMN IF EXISTS "passwordResetExpires";
