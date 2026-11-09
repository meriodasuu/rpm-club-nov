ALTER TABLE rental_requests
  ADD COLUMN offer_id uuid REFERENCES offers(id);

CREATE INDEX rental_requests_offer ON rental_requests(offer_id)
  WHERE offer_id IS NOT NULL;
