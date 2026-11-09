CREATE TABLE roulette_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  approved boolean NOT NULL DEFAULT false,
  daily_attempts integer NOT NULL DEFAULT 0 CHECK (daily_attempts BETWEEN 0 AND 100),
  award_ttl_days integer NOT NULL DEFAULT 0 CHECK (award_ttl_days BETWEEN 0 AND 365),
  version integer NOT NULL DEFAULT 1,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR (approved AND daily_attempts > 0 AND award_ttl_days > 0))
);
INSERT INTO roulette_settings(id) VALUES(true);

CREATE TABLE roulette_prizes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_-]{2,60}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 100),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 220),
  terms text NOT NULL CHECK (length(terms) BETWEEN 1 AND 10000),
  image_url text NOT NULL,
  image_alt text NOT NULL,
  effect_type text NOT NULL CHECK (effect_type IN ('percent','fixed','free_day','wash','upgrade','bonus','info')),
  effect_value integer NOT NULL DEFAULT 0 CHECK (effect_value BETWEEN 0 AND 1000000000),
  weight integer NOT NULL CHECK (weight BETWEEN 1 AND 1000000),
  minimum_tier text REFERENCES loyalty_tiers,
  car_ids uuid[] NOT NULL DEFAULT '{}',
  min_days integer NOT NULL DEFAULT 1 CHECK (min_days BETWEEN 1 AND 90),
  max_days integer NOT NULL DEFAULT 90 CHECK (max_days BETWEEN 1 AND 90),
  min_total_kopecks bigint NOT NULL DEFAULT 0 CHECK (min_total_kopecks >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  issue_cap integer CHECK (issue_cap > 0),
  issued_count integer NOT NULL DEFAULT 0 CHECK (issued_count >= 0),
  active boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at),
  CHECK (min_days <= max_days),
  CHECK (effect_type <> 'percent' OR effect_value BETWEEN 1 AND 9999),
  CHECK (effect_type <> 'fixed' OR effect_value > 0),
  CHECK (effect_type NOT IN ('wash','upgrade','info') OR effect_value = 0)
);
CREATE INDEX roulette_prizes_pool ON roulette_prizes(active,sort_order) WHERE archived_at IS NULL;

CREATE TABLE roulette_attempt_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  period_key date NOT NULL,
  granted integer NOT NULL CHECK (granted >= 0),
  consumed integer NOT NULL DEFAULT 0 CHECK (consumed >= 0 AND consumed <= granted),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,period_key)
);
CREATE TABLE roulette_spins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key uuid NOT NULL,
  config_version integer NOT NULL,
  prize_id uuid NOT NULL REFERENCES roulette_prizes(id),
  prize_snapshot jsonb NOT NULL,
  attempt_grant_id uuid NOT NULL REFERENCES roulette_attempt_grants(id),
  status text NOT NULL DEFAULT 'completed' CHECK (status='completed'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,idempotency_key)
);
CREATE INDEX roulette_spins_user_date ON roulette_spins(user_id,created_at DESC);
CREATE TABLE roulette_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spin_id uuid NOT NULL UNIQUE REFERENCES roulette_spins(id),
  user_id uuid NOT NULL REFERENCES users(id),
  prize_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','redeemed','expired')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  reserved_request_id uuid,
  redeemed_at timestamptz,
  terminal_reason text
);
CREATE INDEX roulette_awards_user_status ON roulette_awards(user_id,status,issued_at DESC);
ALTER TABLE rental_requests ADD COLUMN roulette_award_id uuid UNIQUE REFERENCES roulette_awards(id);
ALTER TABLE rental_requests ADD COLUMN roulette_effect_kopecks bigint NOT NULL DEFAULT 0 CHECK (roulette_effect_kopecks >= 0);
ALTER TABLE rental_requests ADD COLUMN roulette_prize_snapshot jsonb;
ALTER TABLE roulette_awards ADD CONSTRAINT roulette_awards_reserved_request_fk FOREIGN KEY (reserved_request_id) REFERENCES rental_requests(id);

CREATE FUNCTION add_roulette_to_rpm_rent_export() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.roulette_award_id IS NOT NULL THEN
    UPDATE rpm_rent_exports SET payload=payload || jsonb_build_object(
      'prizeTitle', NEW.roulette_prize_snapshot->>'title',
      'prizeEffectKopecks', NEW.roulette_effect_kopecks::text,
      'prizeTerms', left(coalesce(NEW.roulette_prize_snapshot->>'terms',''),500)
    ) WHERE request_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_roulette_rpm_rent_export AFTER INSERT ON rental_requests
FOR EACH ROW EXECUTE FUNCTION add_roulette_to_rpm_rent_export();

DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['roulette_settings','roulette_prizes','roulette_attempt_grants','roulette_spins','roulette_awards'] LOOP
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
