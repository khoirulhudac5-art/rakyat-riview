-- Migration: 20261111000100_v2_admin_card_archive.sql
-- Purpose: Schema and records for Admin Card Archiving ("Arsip Kartu")
--
-- This migration documents and formalizes the persistence mechanism for archiving
-- cards in Rakyat Review V2 Admin without deleting card data or affecting QR/NFC routing.

BEGIN;

-- 1. Ensure permanent Archive Batch record exists in buyer_card_batch
-- Request ID: a0000000-0000-0000-0000-000000000001
-- Actor: admin:archive_registry
INSERT INTO public.buyer_card_batch (
  request_id,
  actor,
  quantity,
  created_at
)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'admin:archive_registry',
  0,
  timezone('utc', now())
)
ON CONFLICT (request_id) DO NOTHING;

-- 2. Optional direct dedicated table for admin archived cards (clean alternative/view)
CREATE TABLE IF NOT EXISTS public.admin_card_archives (
  card_code text PRIMARY KEY,
  archived_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  archived_by text DEFAULT 'admin'
);

-- Enable RLS on admin_card_archives
ALTER TABLE public.admin_card_archives ENABLE ROW LEVEL SECURITY;

-- Allow service_role full management
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'admin_card_archives' AND policyname = 'service_role_admin_card_archives_all'
  ) THEN
    CREATE POLICY service_role_admin_card_archives_all
      ON public.admin_card_archives
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- 3. Document helper view for admin card visibility
CREATE OR REPLACE VIEW public.v_admin_active_cards AS
SELECT c.*
FROM public.card c
WHERE NOT EXISTS (
  SELECT 1 FROM public.buyer_card_batch_items bi
  WHERE bi.request_id = 'a0000000-0000-0000-0000-000000000001'
    AND bi.card_code = c.card_code
);

COMMIT;
