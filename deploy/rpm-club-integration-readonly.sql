-- Apply as the database administrator to database rpm_club.
-- This creates a non-login permission group. Create a project-specific LOGIN
-- role later and grant it membership in rpm_club_integration_ro.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rpm_club_integration_ro') THEN
    CREATE ROLE rpm_club_integration_ro
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE rpm_club_integration_ro
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE rpm_club TO rpm_club_integration_ro;

CREATE SCHEMA IF NOT EXISTS integration AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA integration FROM PUBLIC;
GRANT USAGE ON SCHEMA integration TO rpm_club_integration_ro;

CREATE OR REPLACE VIEW integration.v_members
WITH (security_barrier = true)
AS
SELECT
  u.id AS user_id,
  u.public_member_id,
  u.name,
  u.status,
  a.achieved_tier,
  a.member_since,
  a.total_rental_amount AS total_rental_amount_kopecks,
  u.created_at
FROM public.users AS u
JOIN public.loyalty_accounts AS a ON a.user_id = u.id;

ALTER VIEW integration.v_members OWNER TO postgres;
REVOKE ALL ON integration.v_members FROM PUBLIC;
GRANT SELECT ON integration.v_members TO rpm_club_integration_ro;

-- Future views in this schema must be explicitly granted as well.
