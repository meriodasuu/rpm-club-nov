-- Optional managed-Supabase integrations; portable local PostgreSQL skips them.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='pg_net') THEN
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
    -- Request headers include a worker credential. Only the scheduler owner needs access.
    REVOKE USAGE ON SCHEMA net FROM PUBLIC;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON SCHEMA net FROM anon; END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON SCHEMA net FROM authenticated; END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rpm_club_app') THEN REVOKE ALL ON SCHEMA net FROM rpm_club_app; END IF;
  END IF;
END $$;
