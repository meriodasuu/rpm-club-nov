-- Preserve the rental link when a confirmed website booking is cancelled.
ALTER TABLE rental_requests DROP CONSTRAINT rental_requests_check2;
ALTER TABLE rental_requests ADD CONSTRAINT rental_requests_rental_status_check
  CHECK ((status='accepted' AND rental_id IS NOT NULL)
    OR (status<>'accepted' AND (rental_id IS NULL OR (rpm_rent_managed AND status IN ('cancelled','declined')))));
