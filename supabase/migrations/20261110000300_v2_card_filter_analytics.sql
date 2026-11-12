-- Migration: 20261110000300_v2_card_filter_analytics.sql
-- Purpose: Add optional p_card_code filter to public.buyer_v2_analytics RPC

BEGIN;

DROP FUNCTION IF EXISTS public.buyer_v2_analytics(integer);
DROP FUNCTION IF EXISTS public.buyer_v2_analytics(integer, text);

CREATE OR REPLACE FUNCTION public.buyer_v2_analytics(
  p_days integer DEFAULT 7,
  p_card_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_days int := CASE WHEN p_days IN (7, 30, 90) THEN p_days ELSE 7 END;
  v_card text := CASE WHEN p_card_code IS NOT NULL AND p_card_code ~ '^[A-Za-z0-9_-]{1,30}$' THEN p_card_code ELSE NULL END;
  v_total_cards bigint;
  v_total_scans bigint;
  v_scans_today bigint;
  v_chart_data jsonb;
  v_today_start_utc timestamptz;
  v_period_start_utc timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;

  -- Asia/Jakarta boundary calculations
  v_today_start_utc := (timezone('Asia/Jakarta', clock_timestamp())::date)::timestamp AT TIME ZONE 'Asia/Jakarta';
  v_period_start_utc := ((timezone('Asia/Jakarta', clock_timestamp())::date - (v_days - 1) * interval '1 day'))::timestamp AT TIME ZONE 'Asia/Jakarta';

  -- Total cards owned by user (or 1 if specific card selected)
  IF v_card IS NOT NULL THEN
    SELECT count(*) INTO v_total_cards
    FROM public.buyer_card_ownership
    WHERE user_id = auth.uid() AND card_code = v_card;
  ELSE
    SELECT count(*) INTO v_total_cards
    FROM public.buyer_card_ownership
    WHERE user_id = auth.uid();
  END IF;

  -- Total lifetime scans for cards owned by user
  SELECT count(*) INTO v_total_scans
  FROM public.card_scans s
  JOIN public.buyer_card_ownership o ON o.card_code = s.card_code
  WHERE o.user_id = auth.uid()
    AND (v_card IS NULL OR o.card_code = v_card);

  -- Scans today in Asia/Jakarta
  SELECT count(*) INTO v_scans_today
  FROM public.card_scans s
  JOIN public.buyer_card_ownership o ON o.card_code = s.card_code
  WHERE o.user_id = auth.uid()
    AND (v_card IS NULL OR o.card_code = v_card)
    AND s.scanned_at >= v_today_start_utc;

  -- Chart series generation for N days
  WITH date_series AS (
    SELECT generate_series(
      timezone('Asia/Jakarta', clock_timestamp())::date - (v_days - 1),
      timezone('Asia/Jakarta', clock_timestamp())::date,
      interval '1 day'
    )::date AS d
  ),
  scans_per_day AS (
    SELECT
      (timezone('Asia/Jakarta', s.scanned_at))::date AS s_date,
      count(*) AS s_count
    FROM public.card_scans s
    JOIN public.buyer_card_ownership o ON o.card_code = s.card_code
    WHERE o.user_id = auth.uid()
      AND (v_card IS NULL OR o.card_code = v_card)
      AND s.scanned_at >= v_period_start_utc
    GROUP BY (timezone('Asia/Jakarta', s.scanned_at))::date
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'date', to_char(ds.d, 'YYYY-MM-DD'),
      'day_name', CASE extract(ISODOW FROM ds.d)
        WHEN 1 THEN 'Sen'
        WHEN 2 THEN 'Sel'
        WHEN 3 THEN 'Rab'
        WHEN 4 THEN 'Kam'
        WHEN 5 THEN 'Jum'
        WHEN 6 THEN 'Sab'
        WHEN 7 THEN 'Min'
      END,
      'day_label', to_char(ds.d, 'DD/MM'),
      'count', coalesce(spd.s_count, 0)
    )
    ORDER BY ds.d ASC
  ) INTO v_chart_data
  FROM date_series ds
  LEFT JOIN scans_per_day spd ON spd.s_date = ds.d;

  RETURN jsonb_build_object(
    'period_days', v_days,
    'card_filter', coalesce(v_card, 'all'),
    'total_cards', coalesce(v_total_cards, 0),
    'total_scans', coalesce(v_total_scans, 0),
    'scans_today', coalesce(v_scans_today, 0),
    'chart_data', coalesce(v_chart_data, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.buyer_v2_analytics(integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.buyer_v2_analytics(integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_v2_analytics(integer, text) TO service_role;

-- Resync control fingerprint
UPDATE rr_v2_control.state SET fingerprint = rr_v2_test.fingerprint();
SELECT rr_v2_test.assert_acl();

COMMIT;
