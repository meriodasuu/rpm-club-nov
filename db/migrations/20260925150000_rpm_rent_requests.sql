ALTER TABLE rental_requests
  ADD COLUMN rpm_rent_managed boolean NOT NULL DEFAULT false,
  ADD COLUMN rpm_rent_id text,
  ADD COLUMN rpm_rent_number integer,
  ADD COLUMN rpm_rent_status text,
  ADD COLUMN rpm_rent_sync_error text;

CREATE TABLE rpm_rent_exports (
  request_id uuid PRIMARY KEY REFERENCES rental_requests(id),
  payload jsonb NOT NULL,
  exported_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rpm_rent_deliveries (
  request_id uuid NOT NULL REFERENCES rpm_rent_exports(request_id),
  chat_id text NOT NULL,
  message_id bigint,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  PRIMARY KEY(request_id,chat_id)
);
INSERT INTO program_settings(key,value) VALUES('integration:rpm-rent','{"enabled":false}') ON CONFLICT DO NOTHING;

CREATE FUNCTION enqueue_rpm_rent_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce((SELECT (value->>'enabled')::boolean FROM program_settings WHERE key='integration:rpm-rent'),false) THEN RETURN NEW; END IF;
  INSERT INTO rpm_rent_exports(request_id,payload)
  SELECT NEW.id,jsonb_build_object(
    'requestId',NEW.id,'carId',c.source_id,'carTitle',NEW.car_name,
    'startDate',to_char(NEW.start_date,'YYYY-MM-DD'),'endDate',to_char(NEW.end_date,'YYYY-MM-DD'),
    'days',NEW.days,'grossKopecks',NEW.gross_kopecks::text,'discountKopecks',NEW.discount_kopecks::text,
    'totalKopecks',NEW.total_kopecks::text,'discountBps',NEW.discount_bps,
    'customerName',u.name,'phone',u.phone,'telegram',coalesce('@'||nullif(u.telegram_username,''),'tg://user?id='||u.telegram_id::text),
    'comment',NEW.comment,'createdAt',NEW.created_at,
    'privacyConsentAt',(SELECT max(accepted_at) FROM consent_acceptances WHERE user_id=u.id)
  ) FROM club_content c JOIN users u ON u.id=NEW.user_id WHERE c.id=NEW.car_id AND c.source='rpm-rent';
  IF FOUND THEN UPDATE rental_requests SET rpm_rent_managed=true WHERE id=NEW.id; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rpm_rent_request_enqueue AFTER INSERT ON rental_requests FOR EACH ROW EXECUTE FUNCTION enqueue_rpm_rent_request();
