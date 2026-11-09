CREATE TABLE rental_request_awards (
  request_id uuid NOT NULL REFERENCES rental_requests(id) ON DELETE CASCADE,
  award_id uuid NOT NULL UNIQUE REFERENCES roulette_awards(id),
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 9),
  effect_kopecks bigint NOT NULL DEFAULT 0 CHECK (effect_kopecks >= 0),
  prize_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, award_id),
  UNIQUE (request_id, position)
);
CREATE INDEX rental_request_awards_request ON rental_request_awards(request_id, position);

INSERT INTO rental_request_awards(request_id,award_id,position,effect_kopecks,prize_snapshot)
SELECT r.id,r.roulette_award_id,0,r.roulette_effect_kopecks,
       coalesce(r.roulette_prize_snapshot,a.prize_snapshot)
FROM rental_requests r
JOIN roulette_awards a ON a.id=r.roulette_award_id
ON CONFLICT (award_id) DO NOTHING;

ALTER TABLE rental_request_awards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON rental_request_awards FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON rental_request_awards FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON rental_request_awards FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rpm_club_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON rental_request_awards TO rpm_club_app;
    CREATE POLICY rpm_club_server ON rental_request_awards
      TO rpm_club_app USING (true) WITH CHECK (true);
  END IF;
END $$;
