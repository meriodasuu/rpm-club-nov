CREATE TABLE rental_turnover_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  operation_key text NOT NULL UNIQUE,
  amount_kopecks bigint NOT NULL CHECK(amount_kopecks<>0),
  balance_before_kopecks bigint NOT NULL CHECK(balance_before_kopecks>=0),
  balance_after_kopecks bigint NOT NULL CHECK(balance_after_kopecks>=0),
  reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rental_turnover_adjustments_user_idx
  ON rental_turnover_adjustments(user_id,created_at DESC);

CREATE TRIGGER immutable_rental_turnover_adjustments
  BEFORE UPDATE OR DELETE ON rental_turnover_adjustments
  FOR EACH ROW EXECUTE FUNCTION immutable_record();

ALTER TABLE rental_turnover_adjustments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON rental_turnover_adjustments FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rpm_club_app') THEN
    GRANT SELECT,INSERT ON rental_turnover_adjustments TO rpm_club_app;
    CREATE POLICY rental_turnover_adjustments_server ON rental_turnover_adjustments
      TO rpm_club_app USING(true) WITH CHECK(true);
  END IF;
END $$;
