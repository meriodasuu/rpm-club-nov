-- Legacy completed_at includes a processed_at/created_at backfill: never certify it.
ALTER TABLE public.rentals ADD COLUMN paid_at timestamptz;
ALTER TABLE public.rentals ADD COLUMN trust_metadata jsonb NOT NULL
  DEFAULT '{"completion":"untrusted","payment":"untrusted"}'::jsonb;
ALTER TABLE public.rentals ADD CONSTRAINT rentals_time_trust_check CHECK (
  trust_metadata ?& ARRAY['completion','payment'] AND
  trust_metadata->>'completion' IN ('untrusted','validated_source','operational_transition') AND
  trust_metadata->>'payment' IN ('untrusted','validated_source','operational_transition') AND
  (trust_metadata->>'completion'='untrusted' OR completed_at IS NOT NULL) AND
  (trust_metadata->>'payment'='untrusted' OR paid_at IS NOT NULL)
);

-- Draw MUST acquire this same transaction lock before reading evidence, and must
-- not lock rentals/accounts first. Event time means the database write instant
-- after this lock, not PostgreSQL commit time. Draw waits for earlier writers.
CREATE FUNCTION public.lock_giveaway_rental_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('giveaway-rental-evidence',0));
  RETURN NULL;
END $$;
CREATE TRIGGER giveaway_rental_evidence_lock BEFORE INSERT OR UPDATE OR DELETE ON public.rentals
  FOR EACH STATEMENT EXECUTE FUNCTION public.lock_giveaway_rental_evidence();

CREATE OR REPLACE FUNCTION public.stamp_rental_completion() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE at timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := at;
    -- Preserve notification behavior, but an initial completed import is not a
    -- witnessed transition and its default completion time remains untrusted.
    IF NEW.status='completed' THEN NEW.completed_at := coalesce(NEW.completed_at,at); END IF;
  ELSE
    NEW.created_at := OLD.created_at;
    IF OLD.trust_metadata->>'completion'<>'untrusted' THEN
      NEW.completed_at := OLD.completed_at;
      NEW.trust_metadata := jsonb_set(NEW.trust_metadata,'{completion}',OLD.trust_metadata->'completion');
    ELSIF NEW.status='completed' AND OLD.status<>'completed' AND NEW.mode='operational'
        AND coalesce(current_setting('rpm.rental_event_mode',true),'')<>'import'
        AND NEW.trust_metadata->>'completion'='untrusted' THEN
      NEW.completed_at := at;
      NEW.trust_metadata := jsonb_set(NEW.trust_metadata,'{completion}','"operational_transition"');
    END IF;
    IF OLD.trust_metadata->>'payment'<>'untrusted' THEN
      NEW.paid_at := OLD.paid_at;
      NEW.trust_metadata := jsonb_set(NEW.trust_metadata,'{payment}',OLD.trust_metadata->'payment');
    ELSIF NEW.payment_status='paid' AND OLD.payment_status<>'paid' AND NEW.mode='operational'
        AND coalesce(current_setting('rpm.rental_event_mode',true),'')<>'import'
        AND NEW.trust_metadata->>'payment'='untrusted' THEN
      NEW.paid_at := at;
      NEW.trust_metadata := jsonb_set(NEW.trust_metadata,'{payment}','"operational_transition"');
    END IF;
  END IF;
  -- Keep completion notifications compatible; fallback times are not evidence.
  IF NEW.status='completed' AND NEW.completed_at IS NULL THEN NEW.completed_at := at; END IF;
  IF (NEW.trust_metadata->>'completion'<>'untrusted' AND
      (NEW.completed_at IS NULL OR NOT isfinite(NEW.completed_at) OR NEW.completed_at>at OR
       NEW.completed_at < NEW.start_date::timestamp AT TIME ZONE 'Europe/Moscow')) OR
     (NEW.trust_metadata->>'payment'<>'untrusted' AND
      (NEW.paid_at IS NULL OR NOT isfinite(NEW.paid_at) OR NEW.paid_at>at)) THEN
    RAISE EXCEPTION 'Invalid trusted rental timestamp';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE public.giveaway_rental_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rental_id uuid NOT NULL REFERENCES public.rentals(id),
  user_id uuid NOT NULL REFERENCES public.users(id),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  transaction_id bigint NOT NULL DEFAULT txid_current(),
  status text NOT NULL,
  payment_status text NOT NULL,
  current_amount_kopecks bigint NOT NULL,
  completed_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL,
  trust_metadata jsonb NOT NULL
);
CREATE INDEX giveaway_rental_events_asof_idx ON public.giveaway_rental_events(rental_id,changed_at DESC,id DESC);
CREATE INDEX giveaway_rental_events_user_idx ON public.giveaway_rental_events(user_id,changed_at);

CREATE FUNCTION public.record_giveaway_rental_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.status,NEW.payment_status,NEW.current_amount_kopecks,NEW.completed_at,NEW.paid_at,NEW.trust_metadata)
    IS NOT DISTINCT FROM ROW(OLD.status,OLD.payment_status,OLD.current_amount_kopecks,OLD.completed_at,OLD.paid_at,OLD.trust_metadata) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.giveaway_rental_events(rental_id,user_id,status,payment_status,current_amount_kopecks,completed_at,paid_at,created_at,trust_metadata)
    VALUES(NEW.id,NEW.user_id,NEW.status,NEW.payment_status,NEW.current_amount_kopecks,NEW.completed_at,NEW.paid_at,NEW.created_at,NEW.trust_metadata);
  RETURN NULL;
END $$;
CREATE TRIGGER giveaway_rental_evidence AFTER INSERT OR UPDATE ON public.rentals
  FOR EACH ROW EXECUTE FUNCTION public.record_giveaway_rental_evidence();

-- Baseline records preserve legacy values without claiming their event dates.
INSERT INTO public.giveaway_rental_events(rental_id,user_id,status,payment_status,current_amount_kopecks,completed_at,paid_at,created_at,trust_metadata)
  SELECT id,user_id,status,payment_status,current_amount_kopecks,completed_at,paid_at,created_at,trust_metadata FROM public.rentals;
CREATE FUNCTION public.guard_giveaway_rental_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Giveaway rental evidence is immutable';
END $$;
CREATE TRIGGER giveaway_rental_evidence_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.giveaway_rental_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_giveaway_rental_evidence();
REVOKE ALL ON FUNCTION public.lock_giveaway_rental_evidence(),public.record_giveaway_rental_evidence(),public.guard_giveaway_rental_evidence() FROM PUBLIC;
