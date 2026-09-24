-- Run as the database owner after migrations, only in the dedicated Club database.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO rpm_club_app;
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations' LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO rpm_club_app', t.tablename);
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t.tablename AND policyname='rpm_club_server') THEN
      EXECUTE format('CREATE POLICY rpm_club_server ON public.%I TO rpm_club_app USING(true) WITH CHECK(true)', t.tablename);
    END IF;
  END LOOP;
END $$;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rpm_club_app;
GRANT SELECT ON schema_migrations TO rpm_club_app;
