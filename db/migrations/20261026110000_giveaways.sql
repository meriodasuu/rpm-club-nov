CREATE TABLE giveaways (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK(length(title) BETWEEN 2 AND 120),
  description text NOT NULL DEFAULT '' CHECK(length(description)<=5000),
  rules text NOT NULL CHECK(length(rules) BETWEEN 2 AND 10000),
  image_url text NOT NULL DEFAULT '',
  image_alt text NOT NULL DEFAULT '',
  minimum_tier text NOT NULL REFERENCES loyalty_tiers(code),
  minimum_amount_kopecks bigint NOT NULL CHECK(minimum_amount_kopecks>=0),
  winner_count integer NOT NULL CHECK(winner_count BETWEEN 1 AND 1000),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','drawn','cancelled')),
  published_at timestamptz,
  drawn_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(starts_at < ends_at),
  CHECK((status<>'cancelled') OR cancellation_reason IS NOT NULL)
);
CREATE INDEX giveaways_visible_idx ON giveaways(status,starts_at,ends_at);

CREATE TABLE giveaway_participants (
  giveaway_id uuid NOT NULL REFERENCES giveaways(id),
  user_id uuid NOT NULL REFERENCES users(id),
  qualified_amount_kopecks bigint NOT NULL CHECK(qualified_amount_kopecks>=0),
  qualifying_rental_ids uuid[] NOT NULL DEFAULT '{}',
  qualified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(giveaway_id,user_id)
);
CREATE TABLE giveaway_draws (
  giveaway_id uuid PRIMARY KEY REFERENCES giveaways(id),
  participant_snapshot jsonb NOT NULL,
  random_algorithm text NOT NULL DEFAULT 'node:crypto.randomInt/fisher-yates',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE giveaway_winners (
  giveaway_id uuid NOT NULL REFERENCES giveaways(id),
  position integer NOT NULL CHECK(position>0),
  user_id uuid NOT NULL REFERENCES users(id),
  prize_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','issued','cancelled')),
  issued_at timestamptz,
  issued_by text,
  PRIMARY KEY(giveaway_id,position),
  UNIQUE(giveaway_id,user_id)
);
CREATE INDEX giveaway_winners_user_idx ON giveaway_winners(user_id,status);

ALTER TABLE giveaways ENABLE ROW LEVEL SECURITY;
ALTER TABLE giveaway_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE giveaway_draws ENABLE ROW LEVEL SECURITY;
ALTER TABLE giveaway_winners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON giveaways,giveaway_participants,giveaway_draws,giveaway_winners FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rpm_club_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON giveaways,giveaway_participants,giveaway_draws,giveaway_winners TO rpm_club_app;
    CREATE POLICY giveaway_server ON giveaways TO rpm_club_app USING(true) WITH CHECK(true);
    CREATE POLICY giveaway_participant_server ON giveaway_participants TO rpm_club_app USING(true) WITH CHECK(true);
    CREATE POLICY giveaway_draw_server ON giveaway_draws TO rpm_club_app USING(true) WITH CHECK(true);
    CREATE POLICY giveaway_winner_server ON giveaway_winners TO rpm_club_app USING(true) WITH CHECK(true);
  END IF;
END $$;
