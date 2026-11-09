-- RPM Rent -> RPM Club: confirm and post cashback for a completed, paid rental.
-- Apply as a PostgreSQL administrator after 20261030110000_rpm_rent_bot_integration.sql.
-- p_external_rental_id is the bot's stable rental ID (idempotency key).
-- p_amount_rubles is the qualifying rental price in whole rubles, excluding
-- deposits, penalties, fuel, washing and other non-rental charges.

CREATE OR REPLACE FUNCTION integration.confirm_rental_cashback(
  p_user_id uuid,
  p_amount_rubles bigint,
  p_manager_id text,
  p_external_rental_id text,
  p_car_name text,
  p_start_date date,
  p_end_date date
)
RETURNS TABLE (
  result text,
  rental_id uuid,
  user_id uuid,
  amount_rubles bigint,
  cashback_bonus bigint,
  tier text,
  bonus_available bigint,
  account_version bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, integration
AS $$
DECLARE
  v_manager_id text := nullif(btrim(p_manager_id), '');
  v_external_id text := nullif(btrim(p_external_rental_id), '');
  v_car_name text := nullif(btrim(p_car_name), '');
  v_amount_kopecks bigint;
  v_today_moscow date := (clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date;
  v_existing public.rentals%ROWTYPE;
  v_program public.program_versions%ROWTYPE;
  v_account public.loyalty_accounts%ROWTYPE;
  v_effective_tier text;
  v_rate_bps integer := 0;
  v_cashback bigint := 0;
  v_rental_id uuid;
  v_transaction_id uuid;
  v_expiry timestamptz;
BEGIN
  IF p_user_id IS NULL
     OR p_amount_rubles IS NULL OR p_amount_rubles <= 0
     OR p_amount_rubles > 9223372036854
     OR v_manager_id IS NULL OR char_length(v_manager_id) > 160
     OR v_external_id IS NULL OR char_length(v_external_id) > 128
     OR v_car_name IS NULL OR char_length(v_car_name) > 200
     OR p_start_date IS NULL OR p_end_date IS NULL OR p_start_date > p_end_date
     OR p_end_date > v_today_moscow THEN
    RAISE EXCEPTION 'Invalid rental confirmation fields' USING ERRCODE = '22023';
  END IF;
  v_amount_kopecks := p_amount_rubles * 100;

  -- Serialize retries and concurrent confirmations for the same external rental.
  PERFORM pg_advisory_xact_lock(hashtextextended('rpm-rent:' || v_external_id, 0));

  SELECT r.* INTO v_existing
  FROM public.rentals AS r
  WHERE r.external_rental_id = v_external_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.user_id <> p_user_id
       OR v_existing.amount_kopecks <> v_amount_kopecks
       OR v_existing.car_name <> v_car_name
       OR v_existing.start_date <> p_start_date
       OR v_existing.end_date <> p_end_date
       OR v_existing.source <> 'rpm_rent_bot'
       OR v_existing.status <> 'completed'
       OR v_existing.payment_status <> 'paid'
       OR NOT v_existing.is_qualified THEN
      RAISE EXCEPTION 'Rental ID already exists with different or incompatible data' USING ERRCODE = '23505';
    END IF;

    SELECT a.* INTO v_account FROM public.loyalty_accounts AS a WHERE a.user_id = p_user_id;
    v_effective_tier := greatest(
      (SELECT rank FROM public.loyalty_tiers WHERE code = v_account.calculated_tier),
      (SELECT rank FROM public.loyalty_tiers WHERE code = v_account.achieved_tier),
      coalesce((SELECT rank FROM public.loyalty_tiers WHERE code = v_account.manual_override), 0)
    );
    SELECT t.code INTO v_effective_tier
    FROM public.loyalty_tiers AS t WHERE t.rank = v_effective_tier;
    RETURN QUERY SELECT 'duplicate'::text, v_existing.id, p_user_id,
      p_amount_rubles, v_existing.net_cashback, v_effective_tier,
      v_account.bonus_available, v_account.account_version;
    RETURN;
  END IF;

  SELECT u.status INTO v_effective_tier FROM public.users AS u WHERE u.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Client was not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_effective_tier <> 'active' THEN
    RAISE EXCEPTION 'Rental cashback can be granted only to active clients' USING ERRCODE = '55000';
  END IF;

  SELECT pv.* INTO v_program
  FROM public.program_versions AS pv
  ORDER BY pv.version DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Loyalty program settings were not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT a.* INTO v_account
  FROM public.loyalty_accounts AS a
  WHERE a.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Client loyalty account was not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.rentals(
    external_rental_id, user_id, source, car_name, start_date, end_date,
    amount_kopecks, current_amount_kopecks, status, payment_status,
    qualified_at, processed_at, program_version_id, applied_rate_bps,
    payload_hash, mode, is_qualified, net_cashback, completed_at, paid_at
  ) VALUES (
    v_external_id, p_user_id, 'rpm_rent_bot', v_car_name, p_start_date, p_end_date,
    v_amount_kopecks, v_amount_kopecks, 'completed', 'paid',
    clock_timestamp(), clock_timestamp(), v_program.id, 0,
    encode(digest(concat_ws('|',p_user_id::text,v_amount_kopecks::text,v_car_name,p_start_date::text,p_end_date::text), 'sha256'),'hex'),
    'operational', true, 0,
    (p_end_date::timestamp AT TIME ZONE 'Europe/Moscow'), clock_timestamp()
  ) RETURNING id INTO v_rental_id;

  UPDATE public.loyalty_accounts AS a
  SET total_rental_amount = a.total_rental_amount + v_amount_kopecks
  WHERE a.user_id = p_user_id
  RETURNING a.* INTO v_account;

  SELECT t.code INTO v_effective_tier
  FROM public.loyalty_tiers AS t
  WHERE t.rank = greatest(
    (SELECT rank FROM public.loyalty_tiers WHERE code = v_account.calculated_tier),
    (SELECT rank FROM public.loyalty_tiers WHERE code = v_account.achieved_tier),
    coalesce((SELECT rank FROM public.loyalty_tiers WHERE code = v_account.manual_override), 0),
    coalesce((
      SELECT (tier_row.value->>'rank')::integer
      FROM jsonb_array_elements(v_program.tiers) AS tier_row(value)
      WHERE (tier_row.value->>'thresholdKopecks')::numeric <= v_account.total_rental_amount
      ORDER BY (tier_row.value->>'thresholdKopecks')::numeric DESC LIMIT 1
    ), 0)
  );

  UPDATE public.loyalty_accounts AS a
  SET calculated_tier = (
        SELECT (tier_row.value->>'code')::text
        FROM jsonb_array_elements(v_program.tiers) AS tier_row(value)
        WHERE (tier_row.value->>'thresholdKopecks')::numeric <= v_account.total_rental_amount
        ORDER BY (tier_row.value->>'thresholdKopecks')::numeric DESC LIMIT 1
      ),
      achieved_tier = CASE
        WHEN (SELECT rank FROM public.loyalty_tiers WHERE code = v_effective_tier)
           > (SELECT rank FROM public.loyalty_tiers WHERE code = a.achieved_tier)
        THEN v_effective_tier ELSE a.achieved_tier END,
      member_since = coalesce(a.member_since, clock_timestamp())
  WHERE a.user_id = p_user_id
  RETURNING a.* INTO v_account;

  IF (v_program.tiers->0) IS NOT NULL
     AND v_program.tiers IS NOT NULL
    AND coalesce((SELECT (tier_row.value->>'rateBps')::integer
       FROM jsonb_array_elements(v_program.tiers) AS tier_row(value)
       WHERE tier_row.value->>'code' = v_effective_tier), 0) >= 0 THEN
    v_rate_bps := CASE
      WHEN coalesce(to_jsonb(v_program)->>'reward_mode', 'cashback') = 'discount' THEN 0
      ELSE coalesce((SELECT (tier_row.value->>'rateBps')::integer
        FROM jsonb_array_elements(v_program.tiers) AS tier_row(value)
        WHERE tier_row.value->>'code' = v_effective_tier), 0)
    END;
  END IF;
  v_cashback := (v_amount_kopecks::numeric * v_rate_bps / 1000000)::bigint;
  v_expiry := clock_timestamp() + make_interval(days => v_program.expiry_days);

  UPDATE public.rentals SET applied_rate_bps = v_rate_bps, net_cashback = v_cashback
  WHERE id = v_rental_id;

  IF v_cashback > 0 THEN
    INSERT INTO public.bonus_transactions(
      user_id, rental_id, external_rental_id, type, amount, posting_state,
      business_key, reason, actor_id, program_version_id
    ) VALUES (
      p_user_id, v_rental_id, v_external_id, 'rental_cashback', v_cashback,
      'posted', 'rental:' || v_rental_id::text,
      'Cashback за аренду, подтверждённую RPM Rent', v_manager_id, v_program.id
    ) RETURNING id INTO v_transaction_id;

    INSERT INTO public.bonus_lots(
      user_id, credit_transaction_id, issued_amount, remaining_amount, available_at, expires_at
    ) VALUES (
      p_user_id, v_transaction_id, v_cashback,
      greatest(v_cashback - least(v_account.bonus_debt, v_cashback), 0),
      clock_timestamp(), v_expiry
    );

    IF v_account.bonus_debt > 0 THEN
      INSERT INTO public.bonus_allocations(transaction_id, lot_id, amount, kind)
      SELECT v_transaction_id, l.id, least(v_account.bonus_debt, v_cashback), 'debt_offset'
      FROM public.bonus_lots AS l WHERE l.credit_transaction_id = v_transaction_id;
    END IF;

    UPDATE public.loyalty_accounts AS a
    SET bonus_debt = a.bonus_debt - least(a.bonus_debt, v_cashback),
        bonus_available = a.bonus_available + greatest(v_cashback - least(a.bonus_debt, v_cashback), 0)
    WHERE a.user_id = p_user_id
    RETURNING a.* INTO v_account;
  END IF;

  INSERT INTO public.audit_logs(actor_id, actor_role, action, entity_type, entity_id, reason, after_data)
  VALUES (
    v_manager_id, 'rpm_rent_bot', 'rental.cashback.confirm', 'rental', v_rental_id::text,
    'Подтверждение завершённой оплаченной аренды из RPM Rent',
    jsonb_build_object('userId',p_user_id,'amountRubles',p_amount_rubles,
      'cashbackBonus',v_cashback,'rateBps',v_rate_bps,'tier',v_effective_tier,
      'programVersion',v_program.version,'expiresAt',v_expiry)
  );

  RETURN QUERY SELECT 'processed'::text, v_rental_id, p_user_id,
    p_amount_rubles, v_cashback, v_effective_tier,
    v_account.bonus_available, v_account.account_version;
END;
$$;

REVOKE ALL ON FUNCTION integration.confirm_rental_cashback(uuid,bigint,text,text,text,date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration.confirm_rental_cashback(uuid,bigint,text,text,text,date,date) TO rpm_rent_bot_api;
