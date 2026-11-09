ALTER TABLE users ADD COLUMN first_activated_at timestamptz;
UPDATE users SET first_activated_at=created_at WHERE status='active' AND first_activated_at IS NULL;
CREATE FUNCTION roulette_record_first_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='active' AND NEW.first_activated_at IS NULL THEN
    NEW.first_activated_at=now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER roulette_first_activation BEFORE INSERT OR UPDATE OF status ON users
FOR EACH ROW EXECUTE FUNCTION roulette_record_first_activation();

ALTER TABLE roulette_settings
  ADD COLUMN registration_attempts integer NOT NULL DEFAULT 0 CHECK (registration_attempts BETWEEN 0 AND 100),
  ADD COLUMN registration_enabled_at timestamptz,
  ADD COLUMN attempt_ttl_days integer NOT NULL DEFAULT 30 CHECK (attempt_ttl_days BETWEEN 1 AND 365);
ALTER TABLE roulette_settings DROP CONSTRAINT IF EXISTS roulette_settings_check;
ALTER TABLE roulette_settings ADD CONSTRAINT roulette_settings_enabled_check
  CHECK (NOT enabled OR (approved AND award_ttl_days > 0));

CREATE TABLE roulette_attempt_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  source_type text NOT NULL CHECK (source_type IN ('registration','promo','manual')),
  source_key text NOT NULL,
  granted integer NOT NULL CHECK (granted BETWEEN 1 AND 100),
  consumed integer NOT NULL DEFAULT 0 CHECK (consumed BETWEEN 0 AND granted),
  expires_at timestamptz NOT NULL,
  reason text,
  actor_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,source_type,source_key)
);
CREATE INDEX roulette_attempt_credits_available ON roulette_attempt_credits(user_id,expires_at,id)
  WHERE consumed<granted;

CREATE TABLE roulette_promo_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE,
  code_hint text NOT NULL,
  label text NOT NULL CHECK (length(label) BETWEEN 2 AND 100),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  max_redemptions integer NOT NULL CHECK (max_redemptions BETWEEN 1 AND 1000000),
  redeemed_count integer NOT NULL DEFAULT 0 CHECK (redeemed_count BETWEEN 0 AND max_redemptions),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_by text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(created_by,idempotency_key),
  CHECK (starts_at<expires_at)
);
CREATE TABLE roulette_promo_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_id uuid NOT NULL REFERENCES roulette_promo_codes(id),
  user_id uuid NOT NULL REFERENCES users(id),
  credit_id uuid NOT NULL UNIQUE REFERENCES roulette_attempt_credits(id),
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(promo_id,user_id)
);

ALTER TABLE roulette_spins
  ALTER COLUMN attempt_grant_id DROP NOT NULL,
  ADD COLUMN attempt_credit_id uuid REFERENCES roulette_attempt_credits(id),
  ADD COLUMN pool_snapshot jsonb,
  ADD COLUMN random_ticket bigint,
  ADD COLUMN random_total bigint,
  ADD CONSTRAINT roulette_spin_attempt_source_check CHECK ((attempt_grant_id IS NULL) <> (attempt_credit_id IS NULL)),
  ADD CONSTRAINT roulette_spin_random_check CHECK (random_ticket IS NULL OR (random_ticket >= 0 AND random_total > random_ticket));

CREATE TABLE roulette_spin_denials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (reason IN ('NO_ATTEMPTS','NO_PRIZES','ROULETTE_DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX roulette_spin_denials_date ON roulette_spin_denials(created_at DESC);

DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['roulette_attempt_credits','roulette_promo_codes','roulette_promo_redemptions','roulette_spin_denials'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',tbl);
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON %I FROM anon',tbl); END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON %I FROM authenticated',tbl); END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rpm_club_app') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO rpm_club_app',tbl);
      EXECUTE format('CREATE POLICY rpm_club_server ON %I TO rpm_club_app USING(true) WITH CHECK(true)',tbl);
    END IF;
  END LOOP;
END $$;
