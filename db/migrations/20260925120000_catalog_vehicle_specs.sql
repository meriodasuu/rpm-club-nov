ALTER TABLE club_content ADD COLUMN vehicle_specs jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(vehicle_specs) = 'object');
