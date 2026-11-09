-- Run as a PostgreSQL administrator after migration 20261030110000.
-- This is a permission group, not a login. Create a separate LOGIN role for
-- each bot deployment and grant it membership in this group.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rpm_rent_bot_api') THEN
    CREATE ROLE rpm_rent_bot_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$$;

ALTER ROLE rpm_rent_bot_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE rpm_club TO rpm_rent_bot_api;
GRANT USAGE ON SCHEMA integration TO rpm_rent_bot_api;
GRANT EXECUTE ON FUNCTION integration.find_clients(text,bigint,text,text) TO rpm_rent_bot_api;
GRANT EXECUTE ON FUNCTION integration.client_rental_history(uuid,integer) TO rpm_rent_bot_api;
GRANT EXECUTE ON FUNCTION integration.client_blacklist_status(uuid) TO rpm_rent_bot_api;
GRANT EXECUTE ON FUNCTION integration.set_client_blacklist_status(uuid,boolean,text,text) TO rpm_rent_bot_api;
GRANT EXECUTE ON FUNCTION integration.grant_daily_roulette_attempt(uuid,text,text) TO rpm_rent_bot_api;
GRANT EXECUTE ON FUNCTION integration.record_rental_event(uuid,uuid,text,text,date,date,text,timestamptz,text,text) TO rpm_rent_bot_api;

-- Explicitly deny raw data access, including the integration event table.
REVOKE ALL ON SCHEMA public FROM rpm_rent_bot_api;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM rpm_rent_bot_api;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM rpm_rent_bot_api;
REVOKE ALL ON integration.rpm_rent_rental_events FROM rpm_rent_bot_api;

-- Example for an administrator; replace the password via a protected secret,
-- never commit it. The login receives no permissions except this membership.
-- CREATE ROLE rpm_rent_bot LOGIN PASSWORD 'generated-secret' IN ROLE rpm_rent_bot_api
--   NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
-- ALTER ROLE rpm_rent_bot SET default_transaction_read_only = off;
