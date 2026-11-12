-- Migration: 20261110000200_v2_scan_analytics.sql
-- Purpose: Implement robust server-side scan tracking, anti-duplication, Asia/Jakarta daily metrics, and analytics chart data

BEGIN;

-- 1. Create public.card_scans table
CREATE TABLE IF NOT EXISTS public.card_scans (
  id bigserial PRIMARY KEY,
  card_code text NOT NULL REFERENCES public.card(card_code) ON DELETE CASCADE,
  visitor_hash text,
  scanned_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_card_scans_code_time ON public.card_scans(card_code, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_card_scans_time ON public.card_scans(scanned_at DESC);

-- Enable RLS to isolate table from direct anonymous/authenticated reads
ALTER TABLE public.card_scans ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.card_scans FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.card_scans TO service_role;

-- 2. RPC to resolve card destination and record scan atomically
CREATE OR REPLACE FUNCTION public.resolve_and_record_card_scan(
  p_card_code text,
  p_visitor_hash text DEFAULT NULL,
  p_is_bot boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_card record;
  v_active boolean;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_card_code IS NULL OR p_card_code !~ '^[A-Za-z0-9_-]{1,30}$' THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  SELECT card_code, business_name, review_url, claim_mode, v2_activated_at
  INTO v_card
  FROM public.card
  WHERE card_code = p_card_code;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Determine if card is active
  IF v_card.claim_mode = 'google_first_claim' THEN
    v_active := (v_card.v2_activated_at IS NOT NULL);
  ELSE
    v_active := (v_card.review_url IS NOT NULL AND v_card.review_url <> '');
  END IF;

  -- If active and review_url is configured
  IF v_active AND v_card.review_url IS NOT NULL AND v_card.review_url <> '' THEN
    -- Record scan only if not bot
    IF NOT coalesce(p_is_bot, false) THEN
      -- Anti-duplication: skip if same visitor scanned this card within last 5 minutes
      IF p_visitor_hash IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.card_scans
        WHERE card_code = p_card_code
          AND visitor_hash = p_visitor_hash
          AND scanned_at > v_now - interval '5 minutes'
      ) THEN
        INSERT INTO public.card_scans(card_code, visitor_hash, scanned_at)
        VALUES (p_card_code, p_visitor_hash, v_now);
      END IF;
    END IF;

    RETURN jsonb_build_object(
      'status', 'active',
      'card_code', v_card.card_code,
      'business_name', v_card.business_name,
      'review_url', v_card.review_url
    );
  ELSE
    -- Inactive or unconfigured card
    RETURN jsonb_build_object(
      'status', 'inactive',
      'card_code', v_card.card_code,
      'redirect_url', '/pembeli/mulai.html?card=' || v_card.card_code
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_and_record_card_scan(text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_and_record_card_scan(text, text, boolean) TO service_role;

-- 3. Update public.buyer_v2_list_cards to include scan_count
DROP FUNCTION IF EXISTS public.buyer_v2_list_cards();
CREATE OR REPLACE FUNCTION public.buyer_v2_list_cards()
RETURNS TABLE(
  card_code text,
  business_name text,
  review_url text,
  created_at timestamp with time zone,
  active boolean,
  scan_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    c.card_code,
    c.business_name,
    c.review_url,
    c.created_at,
    (c.v2_activated_at IS NOT NULL) AS active,
    coalesce((SELECT count(*) FROM public.card_scans s WHERE s.card_code = c.card_code), 0)::bigint AS scan_count
  FROM public.card c
  JOIN public.buyer_card_ownership o ON o.card_code = c.card_code
  WHERE o.user_id = auth.uid()
  ORDER BY o.created_at DESC, c.card_code;
$$;

REVOKE ALL ON FUNCTION public.buyer_v2_list_cards() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.buyer_v2_list_cards() TO authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_v2_list_cards() TO service_role;

-- 4. RPC public.buyer_v2_analytics(p_days integer)
CREATE OR REPLACE FUNCTION public.buyer_v2_analytics(p_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_days int := CASE WHEN p_days IN (7, 30, 90) THEN p_days ELSE 7 END;
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
  -- Start of today (00:00:00) in Asia/Jakarta converted to timestamptz (UTC)
  v_today_start_utc := (timezone('Asia/Jakarta', clock_timestamp())::date)::timestamp AT TIME ZONE 'Asia/Jakarta';
  -- Start of the N-day period in Asia/Jakarta
  v_period_start_utc := ((timezone('Asia/Jakarta', clock_timestamp())::date - (v_days - 1) * interval '1 day'))::timestamp AT TIME ZONE 'Asia/Jakarta';

  -- Total cards owned by user
  SELECT count(*) INTO v_total_cards
  FROM public.buyer_card_ownership
  WHERE user_id = auth.uid();

  -- Total lifetime scans for cards owned by user
  SELECT count(*) INTO v_total_scans
  FROM public.card_scans s
  JOIN public.buyer_card_ownership o ON o.card_code = s.card_code
  WHERE o.user_id = auth.uid();

  -- Scans today in Asia/Jakarta
  SELECT count(*) INTO v_scans_today
  FROM public.card_scans s
  JOIN public.buyer_card_ownership o ON o.card_code = s.card_code
  WHERE o.user_id = auth.uid()
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
    'total_cards', v_total_cards,
    'total_scans', v_total_scans,
    'scans_today', v_scans_today,
    'period_days', v_days,
    'chart_data', coalesce(v_chart_data, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.buyer_v2_analytics(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buyer_v2_analytics(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_v2_analytics(integer) TO service_role;

-- 5. Resync fingerprint atomically and assert ACL
UPDATE rr_v2_control.state SET fingerprint = rr_v2_test.fingerprint() WHERE id;
SELECT rr_v2_test.assert_acl();

COMMIT;
