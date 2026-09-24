-- Additive only: no changes to historical rentals or bonus transactions.
CREATE TABLE referral_program_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL UNIQUE CHECK(version > 0),
  enabled boolean NOT NULL,
  referrer jsonb NOT NULL,
  referred jsonb NOT NULL,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL,
  reason text NOT NULL,
  CHECK (NOT enabled OR activated_at IS NOT NULL)
);
CREATE TRIGGER immutable_referral_program BEFORE UPDATE OR DELETE ON referral_program_versions FOR EACH ROW EXECUTE FUNCTION immutable_record();
ALTER TABLE referrals ADD COLUMN manual_version_id uuid REFERENCES referral_program_versions;
CREATE TABLE referral_manual_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id uuid NOT NULL REFERENCES referrals,
  beneficiary_user_id uuid NOT NULL REFERENCES users,
  side text NOT NULL CHECK(side IN ('referrer','referred')),
  rental_id uuid NOT NULL REFERENCES rentals,
  program_version_id uuid NOT NULL REFERENCES referral_program_versions,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  terms text NOT NULL CHECK(length(terms) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','issued','cancelled','review')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  issued_at timestamptz,
  issued_by text,
  issue_comment text,
  cancelled_at timestamptz,
  UNIQUE(referral_id,side),
  CHECK ((status IN ('issued','review')) = (issued_at IS NOT NULL AND issued_by IS NOT NULL AND issue_comment IS NOT NULL)),
  CHECK ((status IN ('cancelled','review')) = (cancelled_at IS NOT NULL))
);
CREATE INDEX referral_manual_awards_user ON referral_manual_awards(beneficiary_user_id,created_at DESC);
CREATE INDEX referral_manual_awards_rental ON referral_manual_awards(rental_id);
CREATE INDEX referral_manual_awards_status ON referral_manual_awards(status,created_at DESC);
CREATE FUNCTION guard_manual_referral_award() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'referral award history cannot be deleted'; END IF;
  IF ROW(NEW.id,NEW.referral_id,NEW.beneficiary_user_id,NEW.side,NEW.rental_id,NEW.program_version_id,NEW.title,NEW.terms,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.referral_id,OLD.beneficiary_user_id,OLD.side,OLD.rental_id,OLD.program_version_id,OLD.title,OLD.terms,OLD.created_at) THEN
    RAISE EXCEPTION 'referral award terms are immutable';
  END IF;
  IF OLD.status IN ('cancelled','review') OR (OLD.status='issued' AND NEW.status<>'review') OR (OLD.status='pending' AND NEW.status NOT IN ('issued','cancelled')) THEN
    RAISE EXCEPTION 'invalid referral award transition';
  END IF;
  IF OLD.issued_at IS NOT NULL AND ROW(NEW.issued_at,NEW.issued_by,NEW.issue_comment) IS DISTINCT FROM ROW(OLD.issued_at,OLD.issued_by,OLD.issue_comment) THEN
    RAISE EXCEPTION 'issuance history is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_manual_referral_award BEFORE UPDATE OR DELETE ON referral_manual_awards FOR EACH ROW EXECUTE FUNCTION guard_manual_referral_award();
REVOKE ALL ON FUNCTION guard_manual_referral_award() FROM PUBLIC;
DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['referral_program_versions','referral_manual_awards'] LOOP
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
