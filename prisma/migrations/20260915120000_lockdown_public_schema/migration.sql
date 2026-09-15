-- Lockdown: revoke Supabase's default anon/authenticated grants on the public schema.
-- The app connects as table owner (bypasses RLS); anon/authenticated hold no grants.
-- Applied out-of-band on staging 2026-09-15; record with:
--   npx prisma migrate resolve --applied "20260915120000_lockdown_public_schema"
--
-- Statement-level: IF NOT EXISTS on CREATE INDEX keeps replays safe.

-- Existing objects: full revoke
REVOKE ALL PRIVILEGES ON ALL TABLES    IN SCHEMA public FROM "anon", "authenticated";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM "anon", "authenticated";
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM "anon", "authenticated";

-- Future objects created by postgres (Prisma migrations) stop re-granting.
-- Covers both roles that Supabase's setup may have configured default privs on.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres        IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES     FROM "anon", "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE postgres        IN SCHEMA public REVOKE SELECT, UPDATE, USAGE                                        ON SEQUENCES FROM "anon", "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE postgres        IN SCHEMA public REVOKE EXECUTE                                                        ON FUNCTIONS FROM "anon", "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES     FROM "anon", "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA public REVOKE SELECT, UPDATE, USAGE                                        ON SEQUENCES FROM "anon", "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA public REVOKE EXECUTE                                                        ON FUNCTIONS FROM "anon", "authenticated";

-- Performance: unindexed FK (Certificate.courseId), flagged by Supabase advisor.
CREATE INDEX IF NOT EXISTS "Certificate_courseId_idx" ON "Certificate"("courseId");
