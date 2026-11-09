-- PENDING EXPLICIT APPROVAL. Existing project only, after V2 migrations 1 and 2.
-- Prevent enumeration of unclaimed V2 IDs; keep all legacy reads unchanged.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $f$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='card'
    AND policyname='public_card_read' AND cmd='SELECT' AND roles=ARRAY['anon']::name[] AND qual='true') THEN
    RAISE EXCEPTION 'Public card policy drift: stop for review';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='card'
    AND policyname<>'public_card_read' AND cmd IN ('SELECT','ALL')) THEN
    RAISE EXCEPTION 'Unexpected read policy could expose unclaimed V2 IDs';
  END IF;
END;
$f$;
ALTER POLICY public_card_read ON public.card USING
  (claim_mode='legacy' OR (claim_mode='google_first_claim' AND v2_activated_at IS NOT NULL));
COMMENT ON POLICY public_card_read ON public.card IS
  'Legacy reads preserved; unclaimed V2 IDs hidden from anonymous enumeration. Targeted status RPC remains available.';
COMMIT;
