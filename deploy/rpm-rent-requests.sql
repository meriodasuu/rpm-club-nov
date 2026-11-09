-- Apply in RPM Rent's database as owner, after provisioning rpm_club_requests.
BEGIN;
ALTER TABLE public."Booking" DROP CONSTRAINT "Booking_originDomain_check";
ALTER TABLE public."Booking" ADD CONSTRAINT "Booking_originDomain_check"
  CHECK ("originDomain" IS NULL OR "originDomain" IN ('rpm-rent.ru','rpmrent.ru')
    OR (source='rpm_club' AND "originDomain"='club.rpm-rent.ru'));
CREATE SCHEMA IF NOT EXISTS rpm_club_requests;
REVOKE ALL ON SCHEMA rpm_club_requests FROM PUBLIC;
CREATE OR REPLACE VIEW rpm_club_requests.bookings AS
SELECT id,"bookingNumber" AS number,status::text,"managerComment" AS note,"updatedAt" AS updated_at,
  substring("idempotencyKey" FROM 10) AS request_id
FROM public."Booking" WHERE source='rpm_club' AND "idempotencyKey" LIKE 'rpm-club:%';
CREATE OR REPLACE VIEW rpm_club_requests.recipients AS
SELECT DISTINCT "telegramUserId" AS chat_id FROM public."TelegramOperator" WHERE "telegramUserId" IS NOT NULL;

CREATE OR REPLACE FUNCTION rpm_club_requests.receive(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b public."Booking"%ROWTYPE; c public."Car"%ROWTYPE; request_key text;
  gross bigint; total bigint; discount bigint; prize_discount bigint; days integer; note text; initial_status public."BookingStatus"; prize_note text;
BEGIN
  request_key := 'rpm-club:'||(p->>'requestId')::uuid::text;
  PERFORM pg_advisory_xact_lock(hashtextextended(request_key,0));
  SELECT * INTO b FROM public."Booking" WHERE "idempotencyKey"=request_key;
  IF FOUND THEN
    IF b.source<>'rpm_club' OR b."carId"<>p->>'carId' OR b.utm->>'rpm_club_payload_hash' IS DISTINCT FROM encode(sha256(convert_to(p::text,'UTF8')),'hex') THEN RAISE EXCEPTION 'BRIDGE_IDEMPOTENCY_CONFLICT'; END IF;
    RETURN jsonb_build_object('id',b.id,'number',b."bookingNumber",'status',b.status,'note',b."managerComment");
  END IF;
  IF NOT (p ?& ARRAY['requestId','carId','carTitle','startDate','endDate','days','grossKopecks','totalKopecks','discountKopecks','discountBps','customerName','phone','createdAt'])
    OR EXISTS (SELECT 1 FROM jsonb_each(p) entry WHERE entry.value='null'::jsonb AND entry.key NOT IN ('telegram','privacyConsentAt')) THEN RAISE EXCEPTION 'BRIDGE_INVALID_REQUEST'; END IF;
  gross := (p->>'grossKopecks')::bigint; total := (p->>'totalKopecks')::bigint;
  discount := (p->>'discountKopecks')::bigint; prize_discount := coalesce((p->>'prizeDiscountKopecks')::bigint,0); days := (p->>'days')::integer;
  IF jsonb_typeof(p->'prizes')='array' THEN
    SELECT string_agg('Приз: '||coalesce(x->>'title','')||' · код '||coalesce(x->>'claimCode',''), E'\n') INTO prize_note FROM jsonb_array_elements(p->'prizes') x;
  END IF;
  IF days NOT BETWEEN 1 AND 90 OR (p->>'endDate')::date-(p->>'startDate')::date<>days
    OR gross<=0 OR total<0 OR discount<0 OR prize_discount<0 OR gross-discount-prize_discount<>total OR gross%100<>0
    OR gross/100>2147483647 OR gross%days<>0 OR gross/days%100<>0
    OR (p->>'discountBps')::integer NOT BETWEEN 0 AND 9999
    OR discount<>gross*(p->>'discountBps')::integer/10000
    OR length(p->>'customerName') NOT BETWEEN 1 AND 200
    OR coalesce(p->>'phone','') !~ '^\+[1-9][0-9]{7,14}$'
    OR length(coalesce(p->>'comment',''))>1000 THEN RAISE EXCEPTION 'BRIDGE_INVALID_REQUEST'; END IF;
  SELECT * INTO c FROM public."Car" WHERE id=p->>'carId' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BRIDGE_CAR_REMOVED'; END IF;
  initial_status := 'NEW';
  IF NOT c.published OR NOT c.available OR c."minimumAge" IS NULL OR c."minimumDrivingExperience" IS NULL OR c."minimumRentalDays" IS NULL OR days<c."minimumRentalDays" THEN
    initial_status := 'DECLINED'; note := 'Автомобиль или условия аренды изменились. Менеджер предложит другой вариант.';
  END IF;
  IF EXISTS (SELECT 1 FROM public."Booking" occupied WHERE occupied."carId"=c.id AND occupied.status IN ('NEW','IN_PROGRESS','CONFIRMED')
    AND daterange(occupied."startAt",occupied."endAt",'[)') && daterange((p->>'startDate')::date,(p->>'endDate')::date,'[)')) THEN
    initial_status := 'DECLINED'; note := 'На выбранные даты автомобиль уже занят. Менеджер предложит другой вариант.';
  END IF;
  BEGIN
    INSERT INTO public."Booking"(id,"carId","carTitle","startAt","endAt","pickupMethod","customerName",phone,telegram,
      "minimumAgeApplied","minimumExperienceApplied","minimumRentalDaysApplied","additionalServiceIds","additionalServicesSnapshot",
      comment,"managerComment","rentalDays","pricePerDaySnapshot","rentalPrice","additionalServicesPrice",deposit,source,"originDomain",utm,
      "idempotencyKey","privacyConsentAt","integrityProtected",status,"createdAt","updatedAt")
    VALUES('club-'||(p->>'requestId'),c.id,p->>'carTitle',(p->>'startDate')::date,(p->>'endDate')::date,'office',p->>'customerName',p->>'phone',p->>'telegram',
      greatest(18,c."minimumAge"),c."minimumDrivingExperience",c."minimumRentalDays",'[]','[]',
      '[Из RPM Club]'||E'\nСкидка по карте/предложению: '||((p->>'discountBps')::numeric/100)::text||'%'||E'\n'||coalesce(prize_note,'')||CASE WHEN prize_discount>0 THEN E'\nСкидка по призам: '||(prize_discount::numeric/100)::text||' ₽' ELSE '' END||E'\nК оплате: '||(total::numeric/100)::text||' ₽'||E'\n'||coalesce(p->>'comment',''),note,days,gross/days/100,gross/100,0,c.deposit,'rpm_club','club.rpm-rent.ru',
      jsonb_build_object('rpm_club_payload_hash',encode(sha256(convert_to(p::text,'UTF8')),'hex'),'rpm_club_request_id',p->>'requestId','rpm_club_total_kopecks',total::text,'rpm_club_discount_kopecks',discount::text,'rpm_club_prize_discount_kopecks',prize_discount::text,'rpm_club_discount_bps',p->>'discountBps'),
      request_key,(p->>'privacyConsentAt')::timestamptz,true,initial_status,(p->>'createdAt')::timestamptz,now()) RETURNING * INTO b;
  EXCEPTION WHEN exclusion_violation THEN
    -- Keep the inquiry in the shared queue, without reserving an already occupied car.
    INSERT INTO public."Booking"(id,"carId","carTitle","startAt","endAt","pickupMethod","customerName",phone,telegram,
      "additionalServiceIds","additionalServicesSnapshot",comment,"managerComment","rentalDays","pricePerDaySnapshot","rentalPrice","additionalServicesPrice",deposit,source,"originDomain",utm,"idempotencyKey","privacyConsentAt","integrityProtected",status,"createdAt","updatedAt")
    VALUES('club-'||(p->>'requestId'),c.id,p->>'carTitle',(p->>'startDate')::date,(p->>'endDate')::date,'office',p->>'customerName',p->>'phone',p->>'telegram','[]','[]',
      '[Из RPM Club]'||E'\n'||coalesce(prize_note,'')||E'\nК оплате со скидкой: '||(total::numeric/100)::text||' ₽'||E'\n'||coalesce(p->>'comment',''),
      'На выбранные даты автомобиль уже занят. Менеджер предложит другой вариант.',days,gross/days/100,gross/100,0,c.deposit,'rpm_club','club.rpm-rent.ru',
      jsonb_build_object('rpm_club_payload_hash',encode(sha256(convert_to(p::text,'UTF8')),'hex'),'rpm_club_request_id',p->>'requestId','rpm_club_total_kopecks',total::text,'rpm_club_discount_kopecks',discount::text,'rpm_club_prize_discount_kopecks',prize_discount::text,'rpm_club_discount_bps',p->>'discountBps'),
      request_key,(p->>'privacyConsentAt')::timestamptz,true,'DECLINED',(p->>'createdAt')::timestamptz,now()) RETURNING * INTO b;
  END;
  RETURN jsonb_build_object('id',b.id,'number',b."bookingNumber",'status',b.status,'note',b."managerComment");
END $$;

CREATE OR REPLACE FUNCTION rpm_club_requests.cancel(request_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  UPDATE public."Booking" SET status='CANCELLED',"updatedAt"=now()
  WHERE source='rpm_club' AND "idempotencyKey"='rpm-club:'||request_id::text AND status IN ('NEW','IN_PROGRESS');
$$;
REVOKE ALL ON ALL TABLES IN SCHEMA rpm_club_requests FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA rpm_club_requests FROM PUBLIC;
GRANT USAGE ON SCHEMA rpm_club_requests TO rpm_club_requests;
GRANT SELECT ON rpm_club_requests.bookings,rpm_club_requests.recipients TO rpm_club_requests;
GRANT EXECUTE ON FUNCTION rpm_club_requests.receive(jsonb),rpm_club_requests.cancel(uuid) TO rpm_club_requests;
COMMIT;
