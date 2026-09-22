-- Run as the managed project administrator after deployment and schema migrations.
-- Provision these Vault secrets first, never put their plaintext values in a migration:
--   rpm_club_worker_secret = the deployed CRON_SECRET
--   rpm_club_worker_origin = the verified HTTPS deployment origin (no trailing slash)
-- Updating the origin secret switches the scheduler on the next deployment.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM vault.secrets WHERE name='rpm_club_worker_secret')
     OR NOT EXISTS(SELECT 1 FROM vault.secrets WHERE name='rpm_club_worker_origin') THEN
    RAISE EXCEPTION 'Provision RPM Club worker Vault secrets first';
  END IF;
END $$;
SELECT cron.schedule('rpm-club-dispatch','* * * * *', $job$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='rpm_club_worker_origin') || '/api/internal/jobs',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='rpm_club_worker_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  ) AS request_id;
$job$);
