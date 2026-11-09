ALTER TABLE users ADD COLUMN offers_consent boolean;
ALTER TABLE users ADD COLUMN routes_consent boolean;
UPDATE users SET offers_consent=marketing_consent,routes_consent=marketing_consent;
ALTER TABLE users ALTER COLUMN offers_consent SET NOT NULL;
ALTER TABLE users ALTER COLUMN routes_consent SET NOT NULL;
ALTER TABLE users ALTER COLUMN offers_consent SET DEFAULT false;
ALTER TABLE users ALTER COLUMN routes_consent SET DEFAULT false;

CREATE TABLE marketing_topic_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users,
  topic text NOT NULL CHECK (topic IN ('offers','routes')),
  granted boolean NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX marketing_topic_consents_user ON marketing_topic_consents(user_id,created_at DESC);
INSERT INTO marketing_topic_consents(user_id,topic,granted,source)
SELECT id,topic,marketing_consent,'legacy_migration'
FROM users CROSS JOIN (VALUES ('offers'),('routes')) AS topics(topic);

CREATE FUNCTION sync_legacy_marketing_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.marketing_consent AND NOT NEW.offers_consent AND NOT NEW.routes_consent THEN
      NEW.offers_consent:=true;
      NEW.routes_consent:=true;
    END IF;
  ELSIF NEW.marketing_consent IS DISTINCT FROM OLD.marketing_consent
    AND NEW.offers_consent IS NOT DISTINCT FROM OLD.offers_consent
    AND NEW.routes_consent IS NOT DISTINCT FROM OLD.routes_consent THEN
    NEW.offers_consent:=NEW.marketing_consent;
    NEW.routes_consent:=NEW.marketing_consent;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_legacy_marketing_consent BEFORE INSERT OR UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION sync_legacy_marketing_consent();

UPDATE trigger_rules SET enabled=false,updated_at=now() WHERE kind='weather';
