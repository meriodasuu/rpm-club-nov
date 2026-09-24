CREATE TABLE staff_bot_login_links (
  code_hash text PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES admin_memberships(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_bot_login_links_member ON staff_bot_login_links(membership_id);
CREATE INDEX staff_bot_login_links_expiry ON staff_bot_login_links(expires_at);
ALTER TABLE staff_bot_login_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON staff_bot_login_links FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON staff_bot_login_links FROM anon; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON staff_bot_login_links FROM authenticated; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rpm_club_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON staff_bot_login_links TO rpm_club_app;
    CREATE POLICY rpm_club_server ON staff_bot_login_links TO rpm_club_app USING(true) WITH CHECK(true);
  END IF;
END $$;
