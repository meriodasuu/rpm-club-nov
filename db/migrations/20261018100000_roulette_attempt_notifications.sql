CREATE FUNCTION roulette_notify_attempt_credit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO outbox_events(event_key,event_type,user_id,aggregate_id,payload)
  VALUES (
    'roulette-attempt-credit:' || NEW.id::text,
    'ROULETTE_ATTEMPTS_GRANTED',
    NEW.user_id,
    NEW.id::text,
    jsonb_build_object(
      'source_type', NEW.source_type,
      'granted', NEW.granted,
      'expires_at', NEW.expires_at
    )
  )
  ON CONFLICT(event_key) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER roulette_attempt_credit_notification
AFTER INSERT ON roulette_attempt_credits
FOR EACH ROW EXECUTE FUNCTION roulette_notify_attempt_credit();
