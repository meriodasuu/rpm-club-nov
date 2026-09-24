-- Financial rules are versioned: this migration preserves every existing program.
ALTER TABLE loyalty_tiers DROP CONSTRAINT loyalty_tiers_code_check;
ALTER TABLE loyalty_tiers ADD CONSTRAINT loyalty_tiers_code_check CHECK(code IN ('MEMBER','DRIVE','BLACK','PLATINUM','RED','SIGNATURE'));
UPDATE loyalty_tiers SET rank=5 WHERE code='SIGNATURE';
UPDATE loyalty_tiers SET rank=4 WHERE code='RED';
INSERT INTO loyalty_tiers(code,rank,name) VALUES('PLATINUM',3,'PLATINUM');
ALTER TABLE program_versions ADD COLUMN reward_mode text NOT NULL DEFAULT 'cashback' CHECK(reward_mode IN ('cashback','discount'));

CREATE TABLE club_content (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK(kind IN ('car','route','wiki')),
  title text NOT NULL CHECK(length(title) BETWEEN 2 AND 160),
  summary text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '',
  image_url text NOT NULL DEFAULT '', link_url text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'general' CHECK(category IN ('general','faq','emergency','rules')),
  daily_price_kopecks bigint NOT NULL DEFAULT 0 CHECK(daily_price_kopecks>=0),
  distance_km integer NOT NULL DEFAULT 0 CHECK(distance_km>=0),
  duration_minutes integer NOT NULL DEFAULT 0 CHECK(duration_minutes>=0),
  active boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
  published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(kind<>'car' OR daily_price_kopecks>0)
);
CREATE INDEX club_content_list ON club_content(kind,active,published_at DESC);

CREATE TABLE rental_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users,
  car_id uuid NOT NULL REFERENCES club_content, car_name text NOT NULL,
  start_date date NOT NULL, end_date date NOT NULL, days integer NOT NULL CHECK(days BETWEEN 1 AND 90),
  gross_kopecks bigint NOT NULL CHECK(gross_kopecks>0), discount_kopecks bigint NOT NULL CHECK(discount_kopecks>=0),
  total_kopecks bigint NOT NULL CHECK(total_kopecks>0), discount_bps integer NOT NULL CHECK(discount_bps BETWEEN 0 AND 9999),
  program_version_id uuid NOT NULL REFERENCES program_versions,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','cancelled')),
  comment text NOT NULL DEFAULT '', staff_note text NOT NULL DEFAULT '', request_key text NOT NULL,
  rental_id uuid UNIQUE REFERENCES rentals, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_key), CHECK(start_date<=end_date), CHECK(total_kopecks=gross_kopecks-discount_kopecks),
  CHECK((status='accepted')=(rental_id IS NOT NULL))
);
CREATE INDEX rental_requests_user ON rental_requests(user_id,created_at DESC);
CREATE INDEX rental_requests_queue ON rental_requests(status,created_at DESC);
CREATE INDEX rental_requests_car ON rental_requests(car_id,start_date,end_date) WHERE status='accepted';

CREATE TABLE trigger_rules (
  kind text PRIMARY KEY CHECK(kind IN ('before_rental','after_rental','offer_reminder','weather','new_route')),
  enabled boolean NOT NULL DEFAULT false, message text NOT NULL,
  lead_hours integer NOT NULL DEFAULT 24 CHECK(lead_hours BETWEEN 1 AND 168),
  city text NOT NULL DEFAULT '', latitude double precision CHECK(latitude BETWEEN -90 AND 90),
  longitude double precision CHECK(longitude BETWEEN -180 AND 180), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO trigger_rules(kind,message) VALUES
  ('before_rental','Скоро ваша поездка. Уточните время и место выдачи у менеджера RPM.'),
  ('after_rental','Спасибо за поездку с RPM! История аренды и ваш статус обновлены в клубе.'),
  ('offer_reminder','В клубе доступно предложение для вас.'),
  ('weather','Прогноз погоды перед вашей поездкой.'),
  ('new_route','Новый маршрут для вашей следующей поездки.');

DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['club_content','rental_requests','trigger_rules'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',tbl);
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON %I FROM anon',tbl); END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON %I FROM authenticated',tbl); END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rpm_club_app') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO rpm_club_app',tbl);
      EXECUTE format('CREATE POLICY rpm_club_server ON %I TO rpm_club_app USING(true) WITH CHECK(true)',tbl);
    END IF;
  END LOOP;
END $$;
