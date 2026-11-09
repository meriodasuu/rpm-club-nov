ALTER TABLE offer_campaigns ADD COLUMN offer_snapshot jsonb;
UPDATE offer_campaigns c SET offer_snapshot=to_jsonb(o) FROM offers o WHERE o.id=c.offer_id;
ALTER TABLE offer_campaigns ALTER COLUMN offer_snapshot SET NOT NULL;

CREATE TABLE offer_campaign_recipients (
  campaign_id uuid NOT NULL REFERENCES offer_campaigns(id),
  offer_id uuid NOT NULL REFERENCES offers(id),
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, user_id)
);
CREATE INDEX offer_campaign_recipients_lookup ON offer_campaign_recipients (offer_id, user_id);

INSERT INTO offer_campaign_recipients (campaign_id, offer_id, user_id)
SELECT c.id, c.offer_id, recipient.value::uuid
FROM offer_campaigns c
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(c.audience)='array' THEN c.audience ELSE '[]'::jsonb END
) AS recipient(value)
WHERE recipient.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ON CONFLICT DO NOTHING;

ALTER TABLE offer_campaign_recipients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON offer_campaign_recipients FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON offer_campaign_recipients FROM anon; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON offer_campaign_recipients FROM authenticated; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rpm_club_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON offer_campaign_recipients TO rpm_club_app;
    CREATE POLICY rpm_club_server ON offer_campaign_recipients TO rpm_club_app USING(true) WITH CHECK(true);
  END IF;
END $$;
