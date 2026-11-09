CREATE OR REPLACE FUNCTION public.stamp_rental_completion() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'completed' THEN NEW.completed_at := coalesce(NEW.completed_at, now()); END IF;
  ELSIF NEW.status = 'completed' AND OLD.completed_at IS NULL THEN
    NEW.completed_at := coalesce(NEW.completed_at, now());
  ELSIF NEW.status = 'completed' AND NEW.completed_at IS NOT NULL
      AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
    NULL;
  ELSE
    NEW.completed_at := OLD.completed_at;
  END IF;
  RETURN NEW;
END $$;
