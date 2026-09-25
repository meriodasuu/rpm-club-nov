CREATE INDEX rpm_rent_exports_due ON rpm_rent_exports(next_attempt_at,created_at) WHERE exported_at IS NULL;
CREATE INDEX rpm_rent_deliveries_due ON rpm_rent_deliveries(next_attempt_at) WHERE delivered_at IS NULL;
ALTER TABLE rpm_rent_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpm_rent_deliveries ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rpm_club_app') THEN
    GRANT SELECT,INSERT,UPDATE ON rpm_rent_exports,rpm_rent_deliveries TO rpm_club_app;
    CREATE POLICY rpm_club_server ON rpm_rent_exports TO rpm_club_app USING(true) WITH CHECK(true);
    CREATE POLICY rpm_club_server ON rpm_rent_deliveries TO rpm_club_app USING(true) WITH CHECK(true);
  END IF;
END $$;
