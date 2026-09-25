CREATE TABLE staff_password_credentials (
  membership_id uuid PRIMARY KEY REFERENCES admin_memberships(id),
  email text NOT NULL UNIQUE CHECK(email=lower(btrim(email))),
  password_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE staff_password_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON staff_password_credentials FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rpm_club_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON staff_password_credentials TO rpm_club_app;
    CREATE POLICY rpm_club_server ON staff_password_credentials TO rpm_club_app USING(true) WITH CHECK(true);
  END IF;
END $$;
-- Old links required a second factor; never reinterpret them as password-reset grants.
DELETE FROM staff_bot_login_links;
