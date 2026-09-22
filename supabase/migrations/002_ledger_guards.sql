CREATE TRIGGER immutable_allocations BEFORE UPDATE OR DELETE ON bonus_allocations FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_referral_rewards BEFORE UPDATE OR DELETE ON referral_rewards FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_tier_events BEFORE UPDATE OR DELETE ON tier_events FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE FUNCTION immutable_rental_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'rental history cannot be deleted'; END IF;
  IF NEW.user_id<>OLD.user_id OR NEW.external_rental_id<>OLD.external_rental_id OR NEW.amount_kopecks<>OLD.amount_kopecks OR NEW.start_date<>OLD.start_date OR NEW.end_date<>OLD.end_date OR NEW.car_name<>OLD.car_name OR NEW.mode<>OLD.mode THEN
    RAISE EXCEPTION 'original rental fields are immutable; use an adjustment';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_rental_origin BEFORE UPDATE OR DELETE ON rentals FOR EACH ROW EXECUTE FUNCTION immutable_rental_origin();
