-- ROLLBACK PLAN & SCRIPTS: 20261109000100_v2_card_production_and_activation.sql
-- 
-- PANDUAN AUDIT KEAMANAN ROLLBACK:
-- Kapan rollback database benar-benar diperlukan?
-- 1. Rollback database HANYA diperlukan jika eksekusi SQL migrasi itu sendiri gagal (syntax/lock conflict)
--    atau menimbulkan regresi langsung pada RPC database existing.
-- 2. Jika masalah berasal dari frontend/backend Vercel (misal: UI bug, env hilang), CUKUP rollback deployment Vercel
--    ke baseline aman (dpl_GCL76P1a8iXKYHHFX8zhgaRjbuGf). JANGAN rollback database, karena skema V2 ini bersifat
--    aditif dan backward-compatible dengan kode V1/baseline!
-- 3. JANGAN PERNAH menjalankan DROP TABLE CASCADE jika sudah ada kartu baru yang digenerate atau dijual,
--    karena akan menghapus token hash dan riwayat klaim pembeli.
--
-- ==============================================================================
-- OPSI A (SANGAT DIREKOMENDASIKAN): NON-DESTRUCTIVE SAFE ROLLBACK
-- Membekukan fitur V2 baru di database tanpa menghapus data kartu baru yang sudah dibuat/diklaim.
-- ==============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- 1. Kembalikan buyer_first_claim ke implementasi baseline
CREATE OR REPLACE FUNCTION public.buyer_first_claim(p_card_code text, p_business_name text, p_review_url text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $f$
DECLARE v_card public.card%ROWTYPE; v_owner uuid; v_count integer;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM auth.identities WHERE user_id=auth.uid() AND provider='google')
    OR p_card_code IS NULL OR p_card_code !~ '^[A-Za-z0-9_-]{24}$'
    OR p_business_name IS NULL OR length(btrim(p_business_name)) NOT BETWEEN 1 AND 150
    OR p_review_url IS NULL OR length(p_review_url)>2048
    OR p_review_url !~ '^https://search\.google\.com/local/writereview\?placeid=ChI[A-Za-z0-9_-]{5,250}$' THEN
    RETURN jsonb_build_object('success',false,'code','invalid_claim');
  END IF;

  INSERT INTO public.buyer_claim_limits(user_id,window_start,attempts) VALUES(auth.uid(),now(),1)
  ON CONFLICT(user_id) DO UPDATE SET
    attempts=CASE WHEN buyer_claim_limits.window_start<=now()-interval '15 minutes' THEN 1 ELSE buyer_claim_limits.attempts+1 END,
    window_start=CASE WHEN buyer_claim_limits.window_start<=now()-interval '15 minutes' THEN now() ELSE buyer_claim_limits.window_start END
  RETURNING attempts INTO v_count;
  IF v_count>20 THEN RETURN jsonb_build_object('success',false,'code','rate_limited'); END IF;

  SELECT * INTO v_card FROM public.card WHERE card_code=p_card_code FOR UPDATE;
  IF NOT FOUND OR v_card.claim_mode<>'google_first_claim' THEN RETURN jsonb_build_object('success',false,'code','not_claimable'); END IF;
  SELECT user_id INTO v_owner FROM public.buyer_card_ownership WHERE card_code=p_card_code;
  IF v_owner IS NOT NULL THEN
    RETURN jsonb_build_object('success',v_owner=auth.uid() AND v_card.v2_activated_at IS NOT NULL,'code','already_claimed');
  END IF;
  PERFORM 1 FROM public.buyer_card_inventory WHERE card_code=p_card_code AND state='ready' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','not_ready'); END IF;
  IF v_card.v2_activated_at IS NOT NULL OR v_card.pin_hash IS NOT NULL OR v_card.review_url IS NOT NULL
    OR EXISTS(SELECT 1 FROM public.card_activation WHERE card_code=p_card_code AND activated_at IS NOT NULL) THEN RETURN jsonb_build_object('success',false,'code','not_claimable'); END IF;
  INSERT INTO public.buyer_card_ownership(card_code,user_id) VALUES(p_card_code,auth.uid());
  UPDATE public.card SET business_name=btrim(p_business_name),review_url=p_review_url,v2_activated_at=now()
  WHERE card_code=p_card_code;
  UPDATE public.buyer_card_inventory SET state='claimed',claimed_at=now(),updated_at=now(),updated_by='google:'||auth.uid()::text WHERE card_code=p_card_code;
  INSERT INTO public.buyer_ownership_audit(card_code,new_owner,actor,reason)
  VALUES(p_card_code,auth.uid(),'google:'||auth.uid()::text,'first_claim');
  RETURN jsonb_build_object('success',true,'code','claimed');
END;
$f$;
REVOKE ALL ON FUNCTION public.buyer_first_claim(text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.buyer_first_claim(text,text,text) TO authenticated;

-- 2. Nonaktifkan RPC baru (cabut akses eksekusi) tanpa merusak tabel data
REVOKE EXECUTE ON FUNCTION public.admin_reissue_v2_activation_token(text, text, text) FROM service_role;
REVOKE EXECUTE ON FUNCTION public.buyer_claim_v2_with_token(text, text, text, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_generate_v2_cards_with_tokens(uuid, integer, jsonb, text) FROM service_role;

-- CATATAN: Tabel buyer_card_activation, buyer_card_batch, dan buyer_card_batch_items
-- TETAP DIPERTAHANKAN. Tidak ada data kartu baru, token hash, atau riwayat pembeli yang terhapus!

COMMIT;

-- ==============================================================================
-- OPSI B (HARD CLEANUP - HANYA JIKA BELUM ADA KARTU AKTIF / TERJUAL):
-- Jalankan manual HANYA bila migrasi gagal total saat preflight dan tidak ada data pembeli.
-- ==============================================================================
-- BEGIN;
-- DO $$
-- BEGIN
--   IF EXISTS(SELECT 1 FROM public.buyer_card_activation WHERE claimed_at IS NOT NULL) THEN
--     RAISE EXCEPTION 'DIBATALKAN: Ada kartu V2 yang sudah aktif/diklaim pembeli. DROP dilarang keras!' USING ERRCODE='55000';
--   END IF;
-- END $$;
-- DROP FUNCTION IF EXISTS public.admin_reissue_v2_activation_token(text, text, text);
-- DROP FUNCTION IF EXISTS public.buyer_claim_v2_with_token(text, text, text, text);
-- DROP FUNCTION IF EXISTS public.admin_generate_v2_cards_with_tokens(uuid, integer, jsonb, text);
-- DROP TABLE IF EXISTS public.buyer_card_batch_items CASCADE;
-- DROP TABLE IF EXISTS public.buyer_card_batch CASCADE;
-- DROP TABLE IF EXISTS public.buyer_card_activation CASCADE;
-- COMMIT;
