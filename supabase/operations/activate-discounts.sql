-- One-time equivalent of scripts/activate-discounts.ts for the reviewed v1.
-- Use the SQL connector if the direct Postgres connection is unavailable.
-- No historical rows are rewritten; repeated execution is a no-op.
DO $$
DECLARE
  previous public.program_versions%ROWTYPE;
  published public.program_versions%ROWTYPE;
  rental_ids uuid[];
  before_rentals jsonb;
  after_rentals jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('program-publish',0));
  SELECT * INTO STRICT previous FROM public.program_versions ORDER BY version DESC LIMIT 1;
  IF previous.reward_mode='discount' THEN RETURN; END IF;
  IF previous.version<>1 OR previous.reward_mode<>'cashback' THEN
    RAISE EXCEPTION 'Program changed: review before publishing';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(previous.tiers) t WHERE (t->>'rateBps')::integer NOT BETWEEN 0 AND 9999) THEN
    RAISE EXCEPTION 'Rates must be reviewed for discounts';
  END IF;
  SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]),coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]'::jsonb)
    INTO rental_ids,before_rentals FROM public.rentals r;
  INSERT INTO public.program_versions(version,tiers,redemption_limit_bps,expiry_days,referrer_reward,referred_reward,program_starts_at,published_by,reward_mode)
    VALUES(previous.version+1,previous.tiers,0,previous.expiry_days,0,0,previous.program_starts_at,'release:discounts-2026-09-23','discount') RETURNING * INTO published;
  INSERT INTO public.audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data,after_data,request_id)
    VALUES('release:discounts-2026-09-23','system','publish_program','program',published.id::text,
      'Скидочная программа по решению заказчика: сохраняем настроенные проценты, пороги и прежние аренды',
      to_jsonb(previous),to_jsonb(published),'activate-discounts:'||previous.id::text);
  INSERT INTO public.outbox_events(event_key,event_type,aggregate_id,payload)
    VALUES('program:'||published.id::text,'PROGRAM_PUBLISHED',published.id::text,jsonb_build_object('programVersionId',published.id));
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]'::jsonb) INTO after_rentals
    FROM public.rentals r WHERE id=ANY(rental_ids);
  IF before_rentals<>after_rentals THEN RAISE EXCEPTION 'Existing rentals changed during publication'; END IF;
END $$;

SELECT version,reward_mode,redemption_limit_bps,referrer_reward,referred_reward,
  (SELECT count(*) FROM public.rentals) preserved_rentals
FROM public.program_versions ORDER BY version DESC LIMIT 1;
