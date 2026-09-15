-- Drop unused isEmailVerified (F3): added speculatively, never read or written
-- by any code path. All 8 existing rows hold the inert DEFAULT false.
ALTER TABLE "User" DROP COLUMN "isEmailVerified";
