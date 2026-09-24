CREATE TABLE staff_browser_handoffs (
  code_hash text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES staff_sessions(id) ON DELETE CASCADE,
  token_encrypted text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX staff_browser_handoffs_session ON staff_browser_handoffs(session_id);
CREATE INDEX staff_browser_handoffs_expiry ON staff_browser_handoffs(expires_at);
ALTER TABLE staff_browser_handoffs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON staff_browser_handoffs FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON staff_browser_handoffs FROM anon; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON staff_browser_handoffs FROM authenticated; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rpm_club_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON staff_browser_handoffs TO rpm_club_app;
    CREATE POLICY rpm_club_server ON staff_browser_handoffs TO rpm_club_app USING(true) WITH CHECK(true);
  END IF;
END $$;
