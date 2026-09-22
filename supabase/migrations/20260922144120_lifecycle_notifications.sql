CREATE TABLE notification_rules(id text PRIMARY KEY,config jsonb NOT NULL,version integer NOT NULL DEFAULT 1,enabled_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE notification_profiles(user_id uuid PRIMARY KEY REFERENCES users,birthday date,birthday_consent_at timestamptz,enabled boolean NOT NULL DEFAULT true,updated_at timestamptz NOT NULL DEFAULT now(),CHECK((birthday IS NULL)=(birthday_consent_at IS NULL)));
CREATE TABLE booking_drafts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users,car_id uuid NOT NULL REFERENCES club_content,start_date date NOT NULL,end_date date NOT NULL,comment text NOT NULL DEFAULT '',request_key text NOT NULL,completed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,car_id),CHECK(start_date<=end_date));
CREATE TABLE notification_activity(identity_key text PRIMARY KEY,user_id uuid REFERENCES users,telegram_id bigint,registration_started_at timestamptz,registered_at timestamptz,can_message boolean NOT NULL DEFAULT false,last_open_at timestamptz,return_open_at timestamptz,previous_open_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE notification_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),trigger_id text NOT NULL REFERENCES notification_rules,identity_key text NOT NULL,user_id uuid REFERENCES users,resource_id text NOT NULL,occurrence_key text NOT NULL,occurred_at timestamptz NOT NULL,scheduled_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,config jsonb NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','cancelled','failed')),reason text,attempts integer NOT NULL DEFAULT 0,lease_until timestamptz,reserved_at timestamptz,sent_at timestamptz,opened_at timestamptz,converted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(trigger_id,identity_key,occurrence_key));
CREATE INDEX notification_due ON notification_runs(status,scheduled_at);
CREATE INDEX notification_recipient ON notification_runs(identity_key,trigger_id,reserved_at DESC);
CREATE INDEX notification_activity_user ON notification_activity(user_id);
CREATE INDEX booking_drafts_user ON booking_drafts(user_id,updated_at);
INSERT INTO program_settings(key,value) VALUES('notifications:limits','{"service":1,"marketing":1}') ON CONFLICT DO NOTHING;
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['notification_rules','notification_profiles','booking_drafts','notification_activity','notification_runs'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',tbl);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON %I FROM anon',tbl); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON %I FROM authenticated',tbl); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rpm_club_app') THEN
   EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO rpm_club_app',tbl);
   EXECUTE format('CREATE POLICY rpm_club_server ON %I TO rpm_club_app USING(true) WITH CHECK(true)',tbl);
  END IF;
 END LOOP;
END $$;
