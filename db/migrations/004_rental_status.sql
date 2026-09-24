ALTER TABLE rentals DROP CONSTRAINT rentals_status_check;
ALTER TABLE rentals ADD CONSTRAINT rentals_status_check CHECK(status IN ('accepted','in_progress','completed','cancelled'));
ALTER TABLE rentals ADD COLUMN version integer NOT NULL DEFAULT 1;
CREATE FUNCTION advance_rental_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_version BEFORE UPDATE ON rentals FOR EACH ROW EXECUTE FUNCTION advance_rental_version();
