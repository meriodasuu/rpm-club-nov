ALTER TABLE offers
  ADD COLUMN offer_type text NOT NULL DEFAULT 'free' CHECK (offer_type IN ('catalog', 'free')),
  ADD COLUMN car_id uuid REFERENCES club_content(id),
  ADD COLUMN discount_bps integer CHECK (discount_bps BETWEEN 1 AND 9999),
  ADD COLUMN archived_at timestamptz;

-- Existing offers were entered manually; keep their prices and history intact.
INSERT INTO audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data)
SELECT 'migration','system','offer.price_migration','offer',id::text,
  'Переход на один ценник свободной акции',to_jsonb(offers)
FROM offers WHERE old_price IS NOT NULL;
UPDATE offers SET old_price = NULL WHERE old_price IS NOT NULL;
CREATE INDEX offers_visible ON offers (created_at DESC) WHERE archived_at IS NULL;
ALTER TABLE offers ADD CONSTRAINT offers_type_fields CHECK (
  (offer_type = 'free' AND car_id IS NULL AND discount_bps IS NULL AND old_price IS NULL)
  OR
  (offer_type = 'catalog' AND car_id IS NOT NULL AND discount_bps IS NOT NULL AND old_price IS NOT NULL AND new_price IS NOT NULL)
);
