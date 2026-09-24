ALTER TABLE admin_memberships ALTER COLUMN auth_user_id DROP NOT NULL;
ALTER TABLE admin_memberships ALTER COLUMN email DROP NOT NULL;
ALTER TABLE admin_memberships ADD COLUMN telegram_user_id uuid UNIQUE REFERENCES users(id);
ALTER TABLE admin_memberships ADD CONSTRAINT staff_identity_provider CHECK(num_nonnulls(auth_user_id,telegram_user_id)=1);
ALTER TABLE admin_memberships ADD CONSTRAINT staff_email_identity CHECK(auth_user_id IS NULL OR email IS NOT NULL);

CREATE TABLE staff_telegram_mfa(
  membership_id uuid PRIMARY KEY REFERENCES admin_memberships(id),
  secret_encrypted text NOT NULL,
  enrollment_expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  last_counter bigint NOT NULL DEFAULT -1
);
ALTER TABLE staff_telegram_mfa ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON staff_telegram_mfa FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON staff_telegram_mfa FROM anon; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON staff_telegram_mfa FROM authenticated; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rpm_club_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON staff_telegram_mfa TO rpm_club_app;
    CREATE POLICY rpm_club_server ON staff_telegram_mfa TO rpm_club_app USING(true) WITH CHECK(true);
  END IF;
END $$;
