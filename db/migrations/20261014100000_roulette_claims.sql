CREATE FUNCTION roulette_claim_code() RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  bytes bytea := gen_random_bytes(10);
  code text := 'RM-';
  i integer;
BEGIN
  FOR i IN 0..9 LOOP
    code := code || substr(alphabet, get_byte(bytes, i) % length(alphabet) + 1, 1);
  END LOOP;
  RETURN code;
END $$;

ALTER TABLE roulette_awards
  ADD COLUMN claim_code text DEFAULT roulette_claim_code(),
  ADD COLUMN redeemed_by uuid REFERENCES admin_memberships(id);

CREATE UNIQUE INDEX roulette_awards_claim_code_key ON roulette_awards(claim_code);

DO $$
DECLARE
  award_id uuid;
BEGIN
  FOR award_id IN SELECT id FROM roulette_awards WHERE claim_code IS NULL LOOP
    LOOP
      BEGIN
        UPDATE roulette_awards SET claim_code = roulette_claim_code() WHERE id = award_id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- Generate another code without changing the award or its history.
      END;
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE roulette_awards
  ALTER COLUMN claim_code SET NOT NULL,
  ADD CONSTRAINT roulette_awards_claim_code_format CHECK (claim_code ~ '^RM-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{10}$');

CREATE INDEX roulette_awards_issued_page ON roulette_awards(issued_at DESC, id DESC);
