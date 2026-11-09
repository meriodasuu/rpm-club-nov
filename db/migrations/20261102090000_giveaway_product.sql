-- Complete giveaway prizes and connect winners to the existing award lifecycle.
CREATE TABLE giveaway_prizes (
  giveaway_id uuid NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK(position BETWEEN 1 AND 1000),
  prize_snapshot jsonb NOT NULL,
  ttl_days integer NOT NULL CHECK(ttl_days BETWEEN 1 AND 365),
  PRIMARY KEY(giveaway_id,position)
);

ALTER TABLE giveaway_winners ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;
ALTER TABLE giveaway_winners ADD COLUMN award_id uuid UNIQUE;
ALTER TABLE roulette_awards ALTER COLUMN spin_id DROP NOT NULL;
ALTER TABLE roulette_awards ADD COLUMN giveaway_winner_id uuid UNIQUE REFERENCES giveaway_winners(id);
ALTER TABLE giveaway_winners ADD CONSTRAINT giveaway_winners_award_fk FOREIGN KEY(award_id) REFERENCES roulette_awards(id);
ALTER TABLE roulette_awards ADD CONSTRAINT roulette_awards_source_check
  CHECK ((spin_id IS NOT NULL) <> (giveaway_winner_id IS NOT NULL));

-- The published rules and prize set are part of the public promise. They must
-- remain immutable so a draw can always be audited against what participants saw.
CREATE OR REPLACE FUNCTION protect_published_giveaway() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
    NEW.title IS DISTINCT FROM OLD.title OR
    NEW.description IS DISTINCT FROM OLD.description OR
    NEW.rules IS DISTINCT FROM OLD.rules OR
    NEW.image_url IS DISTINCT FROM OLD.image_url OR
    NEW.image_alt IS DISTINCT FROM OLD.image_alt OR
    NEW.minimum_tier IS DISTINCT FROM OLD.minimum_tier OR
    NEW.minimum_amount_kopecks IS DISTINCT FROM OLD.minimum_amount_kopecks OR
    NEW.winner_count IS DISTINCT FROM OLD.winner_count OR
    NEW.starts_at IS DISTINCT FROM OLD.starts_at OR
    NEW.ends_at IS DISTINCT FROM OLD.ends_at
  ) THEN
    RAISE EXCEPTION 'Published giveaway rules cannot be changed';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER giveaways_protect_published
  BEFORE UPDATE ON giveaways FOR EACH ROW EXECUTE FUNCTION protect_published_giveaway();

CREATE OR REPLACE FUNCTION protect_published_giveaway_prize() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE giveaway_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO giveaway_status FROM giveaways WHERE id=OLD.giveaway_id;
  ELSE
    SELECT status INTO giveaway_status FROM giveaways WHERE id=NEW.giveaway_id;
  END IF;
  IF giveaway_status <> 'draft' THEN
    RAISE EXCEPTION 'Published giveaway prizes cannot be changed';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER giveaway_prizes_protect_published
  BEFORE INSERT OR UPDATE OR DELETE ON giveaway_prizes FOR EACH ROW EXECUTE FUNCTION protect_published_giveaway_prize();

ALTER TABLE giveaway_prizes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON giveaway_prizes FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rpm_club_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON giveaway_prizes TO rpm_club_app;
    CREATE POLICY giveaway_prize_server ON giveaway_prizes TO rpm_club_app USING(true) WITH CHECK(true);
  END IF;
END $$;
