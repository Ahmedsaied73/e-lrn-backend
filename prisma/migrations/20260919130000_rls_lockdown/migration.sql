-- rls_lockdown: F-S1. anon+authenticated previously held full DML on all
-- public tables (Supabase default grants); the Data API was only incidentally
-- safe (fail-closed probe on empty tables). Enable RLS with NO policies →
-- PostgREST reads 0 rows / writes fail for anon+authenticated, structurally.
-- The app connects as the table owner → bypasses RLS → unchanged behavior.
--
-- Applied out-of-band (prisma db execute --file ... --url $DIRECT_URL, session
-- pooler 5432) while a pending unrelated migration was in the tree; recorded
-- without executing the migration queue via:
--   npx prisma migrate resolve --applied 20260919130000_rls_lockdown
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
  EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated';
END $$;
