-- RPM Rent bot boundary. The bot receives EXECUTE on the functions below only;
-- it never receives rights on public tables.

CREATE SCHEMA IF NOT EXISTS integration;
REVOKE ALL ON SCHEMA integration FROM PUBLIC;
-- A role cannot be denied a privilege inherited through PUBLIC. Removing
-- PUBLIC schema usage is what prevents the bot from calling arbitrary public
-- functions; the application role receives explicit usage below.
REVOKE USAGE ON SCHEMA public FROM PUBLIC;

CREATE TABLE integration.rpm_rent_rental_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES public.users(id),
  club_rental_id uuid REFERENCES public.rentals(id),
  external_rental_id text NOT NULL CHECK (length(external_rental_id) BETWEEN 1 AND 128),
  car_name text NOT NULL CHECK (length(car_name) BETWEEN 1 AND 200),
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('started','completed','cancelled')),
  occurred_at timestamptz NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('manager','technician')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_date <= end_date)
);
CREATE INDEX rpm_rent_rental_events_user_created
  ON integration.rpm_rent_rental_events(user_id, created_at DESC);
CREATE INDEX rpm_rent_rental_events_external_rental
  ON integration.rpm_rent_rental_events(external_rental_id, created_at DESC);

ALTER TABLE integration.rpm_rent_rental_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON integration.rpm_rent_rental_events FROM PUBLIC;

CREATE FUNCTION integration.find_clients(
  p_telegram_username text DEFAULT NULL,
  p_telegram_id bigint DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_name text DEFAULT NULL
)
RETURNS TABLE (
  user_id uuid,
  public_member_id text,
  name text,
  phone text,
  telegram_id bigint,
  telegram_username text,
  account_status text,
  blacklisted boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_username text := nullif(lower(ltrim(btrim(p_telegram_username), '@')), '');
  v_phone text := nullif(btrim(p_phone), '');
  v_name text := nullif(btrim(p_name), '');
BEGIN
  IF v_username IS NULL AND p_telegram_id IS NULL AND v_phone IS NULL AND v_name IS NULL THEN
    RAISE EXCEPTION 'At least one search value is required' USING ERRCODE = '22023';
  END IF;
  IF v_name IS NOT NULL AND char_length(v_name) < 2 THEN
    RAISE EXCEPTION 'Name search must contain at least 2 characters' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT u.id,u.public_member_id,u.name,u.phone,u.telegram_id,u.telegram_username,u.status,(u.status='blocked')
  FROM public.users AS u
  WHERE (v_username IS NULL OR lower(coalesce(u.telegram_username,''))=v_username)
    AND (p_telegram_id IS NULL OR u.telegram_id=p_telegram_id)
    AND (v_phone IS NULL OR u.phone=v_phone)
    AND (v_name IS NULL OR u.name ILIKE '%' || v_name || '%')
  ORDER BY u.created_at DESC,u.id
  LIMIT 20;
END;
$$;

CREATE FUNCTION integration.client_rental_history(
  p_user_id uuid,
  p_limit integer DEFAULT 50
)
RETURNS TABLE (
  rental_id uuid,
  external_rental_id text,
  car_name text,
  start_date date,
  end_date date,
  status text,
  payment_status text,
  amount_kopecks bigint,
  pickup_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_user_id) THEN
    RAISE EXCEPTION 'Client was not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  SELECT r.id,r.external_rental_id,r.car_name,r.start_date,r.end_date,r.status,r.payment_status,
         r.current_amount_kopecks,r.pickup_at,r.completed_at,r.created_at
  FROM public.rentals AS r
  WHERE r.user_id=p_user_id
  ORDER BY r.start_date DESC,r.created_at DESC,r.id DESC
  LIMIT p_limit;
END;
$$;

CREATE FUNCTION integration.client_blacklist_status(p_user_id uuid)
RETURNS TABLE (user_id uuid, account_status text, blacklisted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  SELECT u.id,u.status,(u.status='blocked')
  FROM public.users AS u
  WHERE u.id=p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Client was not found' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

CREATE FUNCTION integration.set_client_blacklist_status(
  p_user_id uuid,
  p_blacklisted boolean,
  p_actor_id text,
  p_reason text
)
RETURNS TABLE (user_id uuid, account_status text, blacklisted boolean, changed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before text;
  v_after text;
BEGIN
  IF nullif(btrim(p_actor_id),'') IS NULL OR char_length(p_actor_id)>160 THEN
    RAISE EXCEPTION 'Actor ID is required and must not exceed 160 characters' USING ERRCODE = '22023';
  END IF;
  IF nullif(btrim(p_reason),'') IS NULL OR char_length(p_reason)>500 THEN
    RAISE EXCEPTION 'Reason is required and must not exceed 500 characters' USING ERRCODE = '22023';
  END IF;

  SELECT status INTO v_before FROM public.users WHERE id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Client was not found' USING ERRCODE = 'P0002';
  END IF;
  v_after := CASE WHEN p_blacklisted THEN 'blocked' ELSE CASE WHEN v_before='blocked' THEN 'active' ELSE v_before END END;

  IF v_before IS DISTINCT FROM v_after THEN
    UPDATE public.users SET status=v_after,updated_at=clock_timestamp() WHERE id=p_user_id;
    INSERT INTO public.audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,before_data,after_data)
    VALUES (btrim(p_actor_id),'rpm_rent_bot','client.blacklist','user',p_user_id::text,btrim(p_reason),
      jsonb_build_object('status',v_before,'blacklisted',v_before='blocked'),
      jsonb_build_object('status',v_after,'blacklisted',v_after='blocked'));
  END IF;

  RETURN QUERY SELECT p_user_id,v_after,(v_after='blocked'),(v_before IS DISTINCT FROM v_after);
END;
$$;

CREATE FUNCTION integration.grant_daily_roulette_attempt(
  p_user_id uuid,
  p_actor_id text,
  p_reason text DEFAULT 'Начисление от RPM Rent'
)
RETURNS TABLE (granted boolean, credit_id uuid, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
  v_period date := (clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date;
  v_ttl_days integer;
  v_credit_id uuid;
  v_expires_at timestamptz;
BEGIN
  IF nullif(btrim(p_actor_id),'') IS NULL OR char_length(p_actor_id)>160 THEN
    RAISE EXCEPTION 'Actor ID is required and must not exceed 160 characters' USING ERRCODE = '22023';
  END IF;
  IF nullif(btrim(p_reason),'') IS NULL OR char_length(p_reason)>500 THEN
    RAISE EXCEPTION 'Reason is required and must not exceed 500 characters' USING ERRCODE = '22023';
  END IF;
  SELECT status INTO v_status FROM public.users WHERE id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Client was not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'Attempts can be granted only to active clients' USING ERRCODE = '55000';
  END IF;
  SELECT attempt_ttl_days INTO v_ttl_days FROM public.roulette_settings WHERE id=true;
  IF v_ttl_days IS NULL THEN
    RAISE EXCEPTION 'Roulette settings were not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.roulette_attempt_credits(user_id,source_type,source_key,granted,expires_at,reason,actor_id)
  VALUES (p_user_id,'manual','rpm-rent-bot:' || v_period::text,1,
    clock_timestamp() + make_interval(days => v_ttl_days),btrim(p_reason),btrim(p_actor_id))
  ON CONFLICT (user_id,source_type,source_key) DO NOTHING
  RETURNING id,expires_at INTO v_credit_id,v_expires_at;

  IF FOUND THEN
    INSERT INTO public.audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,after_data)
    VALUES (btrim(p_actor_id),'rpm_rent_bot','roulette.attempt.grant','user',p_user_id::text,btrim(p_reason),
      jsonb_build_object('creditId',v_credit_id,'period',v_period,'granted',1,'expiresAt',v_expires_at));
    RETURN QUERY SELECT true,v_credit_id,v_expires_at;
    RETURN;
  END IF;

  SELECT id,expires_at INTO v_credit_id,v_expires_at
  FROM public.roulette_attempt_credits
  WHERE user_id=p_user_id AND source_type='manual' AND source_key='rpm-rent-bot:' || v_period::text;
  RETURN QUERY SELECT false,v_credit_id,v_expires_at;
END;
$$;

CREATE FUNCTION integration.record_rental_event(
  p_event_key uuid,
  p_user_id uuid,
  p_external_rental_id text,
  p_car_name text,
  p_start_date date,
  p_end_date date,
  p_status text,
  p_occurred_at timestamptz,
  p_actor_role text,
  p_actor_id text
)
RETURNS TABLE (event_id uuid, duplicate boolean, club_rental_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event_id uuid;
  v_club_rental_id uuid;
  v_existing_user_id uuid;
BEGIN
  IF p_status NOT IN ('started','completed','cancelled') THEN
    RAISE EXCEPTION 'Unsupported event status' USING ERRCODE = '22023';
  END IF;
  IF p_actor_role NOT IN ('manager','technician') THEN
    RAISE EXCEPTION 'Actor role must be manager or technician' USING ERRCODE = '22023';
  END IF;
  IF nullif(btrim(p_external_rental_id),'') IS NULL OR char_length(p_external_rental_id)>128
      OR nullif(btrim(p_car_name),'') IS NULL OR char_length(p_car_name)>200
      OR p_start_date IS NULL OR p_end_date IS NULL OR p_start_date>p_end_date
      OR p_occurred_at IS NULL OR nullif(btrim(p_actor_id),'') IS NULL OR char_length(p_actor_id)>160 THEN
    RAISE EXCEPTION 'Invalid rental event fields' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_user_id) THEN
    RAISE EXCEPTION 'Client was not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT r.id,r.user_id INTO v_club_rental_id,v_existing_user_id
  FROM public.rentals AS r WHERE r.external_rental_id=btrim(p_external_rental_id);
  IF v_existing_user_id IS NOT NULL AND v_existing_user_id<>p_user_id THEN
    RAISE EXCEPTION 'Rental belongs to another client' USING ERRCODE = '23505';
  END IF;

  INSERT INTO integration.rpm_rent_rental_events(
    event_key,user_id,club_rental_id,external_rental_id,car_name,start_date,end_date,status,occurred_at,actor_role,actor_id
  ) VALUES (
    p_event_key,p_user_id,v_club_rental_id,btrim(p_external_rental_id),btrim(p_car_name),p_start_date,p_end_date,p_status,p_occurred_at,p_actor_role,btrim(p_actor_id)
  ) ON CONFLICT (event_key) DO NOTHING
  RETURNING id INTO v_event_id;

  IF FOUND THEN
    INSERT INTO public.audit_logs(actor_id,actor_role,action,entity_type,entity_id,reason,after_data)
    VALUES (btrim(p_actor_id),'rpm_rent_bot','rental.event.record','rpm_rent_rental_event',v_event_id::text,
      'Событие аренды от RPM Rent',jsonb_build_object('status',p_status,'externalRentalId',btrim(p_external_rental_id)));
    RETURN QUERY SELECT v_event_id,false,v_club_rental_id;
    RETURN;
  END IF;

  SELECT id,club_rental_id INTO v_event_id,v_club_rental_id
  FROM integration.rpm_rent_rental_events WHERE event_key=p_event_key;
  RETURN QUERY SELECT v_event_id,true,v_club_rental_id;
END;
$$;

CREATE TRIGGER rpm_rent_rental_events_immutable
BEFORE UPDATE OR DELETE ON integration.rpm_rent_rental_events
FOR EACH ROW EXECUTE FUNCTION public.immutable_record();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rpm_club_app') THEN
    GRANT USAGE ON SCHEMA public TO rpm_club_app;
    GRANT USAGE ON SCHEMA integration TO rpm_club_app;
    GRANT SELECT ON integration.rpm_rent_rental_events TO rpm_club_app;
    CREATE POLICY rpm_club_server ON integration.rpm_rent_rental_events
      TO rpm_club_app USING (true) WITH CHECK (true);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION integration.find_clients(text,bigint,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION integration.client_rental_history(uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION integration.client_blacklist_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION integration.set_client_blacklist_status(uuid,boolean,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION integration.grant_daily_roulette_attempt(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION integration.record_rental_event(uuid,uuid,text,text,date,date,text,timestamptz,text,text) FROM PUBLIC;
