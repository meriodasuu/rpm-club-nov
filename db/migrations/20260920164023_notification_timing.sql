-- Collection times are explicit. Legacy rentals without a time stay unscheduled.
ALTER TABLE public.rentals ADD COLUMN pickup_at timestamptz;
ALTER TABLE public.rentals ADD COLUMN completed_at timestamptz;
ALTER TABLE public.rentals ADD CONSTRAINT rentals_pickup_date_check
  CHECK (pickup_at IS NULL OR (pickup_at AT TIME ZONE 'Europe/Moscow')::date = start_date);
UPDATE public.rentals SET completed_at=coalesce(processed_at,created_at) WHERE status='completed';

CREATE FUNCTION public.stamp_rental_completion() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'completed' THEN NEW.completed_at := now(); END IF;
  ELSIF NEW.status = 'completed' AND OLD.completed_at IS NULL THEN
    NEW.completed_at := now();
  ELSE
    NEW.completed_at := OLD.completed_at;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.stamp_rental_completion() FROM PUBLIC;
CREATE TRIGGER rental_completion BEFORE INSERT OR UPDATE ON public.rentals
  FOR EACH ROW EXECUTE FUNCTION public.stamp_rental_completion();

ALTER TABLE public.offers ADD COLUMN published_at timestamptz;
UPDATE public.offers SET published_at=created_at WHERE active;
CREATE FUNCTION public.stamp_offer_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.active THEN NEW.published_at := now(); END IF;
  ELSIF NEW.active AND OLD.published_at IS NULL THEN
    NEW.published_at := now();
  ELSE
    NEW.published_at := OLD.published_at;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.stamp_offer_publication() FROM PUBLIC;
CREATE TRIGGER offer_publication BEFORE INSERT OR UPDATE ON public.offers
  FOR EACH ROW EXECUTE FUNCTION public.stamp_offer_publication();

-- Enabling notifications must not send a backlog of old publications/completions.
ALTER TABLE public.trigger_rules ADD COLUMN enabled_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.trigger_rules DROP CONSTRAINT trigger_rules_lead_hours_check;
ALTER TABLE public.trigger_rules ADD CONSTRAINT trigger_rules_lead_hours_check CHECK(lead_hours BETWEEN 0 AND 168);
UPDATE public.trigger_rules SET lead_hours=2,updated_at=now() WHERE kind='before_rental';
UPDATE public.trigger_rules SET lead_hours=0,updated_at=now() WHERE kind IN ('after_rental','offer_reminder','new_route');
UPDATE public.trigger_rules SET message='Спасибо за поездку с RPM! Ваша аренда завершена.' WHERE kind='after_rental';
UPDATE public.trigger_rules SET city='Санкт-Петербург',latitude=59.93863,longitude=30.31413,updated_at=now() WHERE kind='weather';
CREATE INDEX rentals_pickup_pending_idx ON public.rentals(pickup_at) WHERE status='accepted' AND mode='operational';
CREATE INDEX rentals_completed_notifications_idx ON public.rentals(completed_at) WHERE status='completed' AND mode='operational';
