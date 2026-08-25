-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: Dealstage tracking via Google Sheets
-- Datum:    2026-04-30
-- Reden:    Sales managers willen dat de "Dealstage"-kolom uit de gekoppelde
--           Google Sheet automatisch op de afspraak verschijnt — net zoals
--           cold callers' leads automatisch gesynced worden.
--
--           Ontwerp:
--             - dealstage_raw           = exacte waarde uit de sheet
--             - dealstage_category      = AI-canonical (won/lost/...) — nullable
--             - dealstage_synced_at     = wanneer laatst gesynced
--             - dealstage_classified_at = wanneer AI 'm geclassificeerd heeft
--           AI-classificatie loopt in batch (1 call per project per nacht) en
--           hoeft niet realtime te gebeuren — daarom 2 timestamps.
--
--           Velden komen op call_records (niet op appointment_feedback) zodat:
--             - dezelfde Google Sheet pipeline werkt
--             - geen NOT NULL sales_rep_id problemen
--             - bestaande RLS volstaat
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Kolommen toevoegen ───────────────────────────────────────────────────────
ALTER TABLE public.call_records
  ADD COLUMN IF NOT EXISTS dealstage_raw           text,
  ADD COLUMN IF NOT EXISTS dealstage_category      text,
  ADD COLUMN IF NOT EXISTS dealstage_synced_at     timestamptz,
  ADD COLUMN IF NOT EXISTS dealstage_classified_at timestamptz;

-- Toegestane waarden voor dealstage_category — soft check, future-proof
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.call_records'::regclass
      AND conname  = 'call_records_dealstage_category_check'
  ) THEN
    ALTER TABLE public.call_records
      ADD CONSTRAINT call_records_dealstage_category_check
      CHECK (
        dealstage_category IS NULL
        OR dealstage_category IN ('won','lost','in_progress','no_show','other')
      );
  END IF;
END $$;


-- 2. Index voor de batch-classifier query ───────────────────────────────────
-- Pakt rijen op die wél een raw-waarde hebben maar nog niet geclassificeerd zijn.
CREATE INDEX IF NOT EXISTS idx_call_records_dealstage_unclassified
  ON public.call_records (project_id, dealstage_raw)
  WHERE dealstage_raw IS NOT NULL AND dealstage_category IS NULL;


-- 3. View appointments_with_feedback uitbreiden ─────────────────────────────
-- We hergebruiken de definitie uit 2026-04-28_caller_id_in_views.sql en voegen
-- de drie dealstage-velden toe.
DROP VIEW IF EXISTS public.appointments_with_feedback CASCADE;

CREATE VIEW public.appointments_with_feedback AS
SELECT
  cr.id              AS call_record_id,
  cr.lead_name,
  cr.call_date,
  cr.notes           AS caller_notes,
  cr.dealstage_raw,
  cr.dealstage_category,
  cr.dealstage_synced_at,

  u.project_id       AS project_id,
  u.call_center_id   AS call_center_id,
  cc.name            AS call_center_name,

  u.caller_id        AS caller_id,
  caller.full_name   AS caller_name,

  af.appointment_status,
  af.outcome,
  af.quality_rating,
  af.notes              AS sales_notes,
  af.appointment_date,

  af.sales_rep_id,
  sales_rep.full_name   AS sales_rep_name
FROM public.call_records cr
JOIN public.uploads      u                   ON u.id  = cr.upload_id
JOIN public.call_centers cc                  ON cc.id = u.call_center_id
LEFT JOIN public.profiles            caller      ON caller.id      = u.caller_id
LEFT JOIN public.appointment_feedback af         ON af.call_record_id = cr.id
LEFT JOIN public.profiles            sales_rep   ON sales_rep.id   = af.sales_rep_id
-- Filter blijft gelijk aan vorige versie: alleen call_records met "afspraak"-
-- achtige status of een bestaande feedback-rij. Dealstage wordt door de sync
-- alleen geschreven op rijen die al "afspraak" zijn, dus aparte clause is overbodig.
WHERE cr.status ILIKE ANY (ARRAY['%afspraak%', '%appointment%'])
   OR af.id IS NOT NULL;

GRANT SELECT ON public.appointments_with_feedback TO anon, authenticated;


-- 4. Bulk-update RPC voor de Pass 2 dealstage-sync ──────────────────────────
-- De Google-sync route zamelt per dag een lijst (external_id, dealstage_raw)
-- in en moet die op call_records propageren — óók voor afspraken op andere
-- datums dan vandaag. Eén RPC-call is veel goedkoper dan N losse updates.
--
-- Gedrag:
--   • Match op (project_id, external_id) waarbij status ILIKE '%afspraak%'
--     of '%appointment%' — dealstage geldt enkel voor afspraken.
--   • Update alleen als dealstage_raw écht wijzigt → dealstage_classified_at
--     wordt dan op NULL gezet zodat de AI 'm hercategoriseert.
--   • dealstage_synced_at wordt áltijd op now() gezet (zo zie je dat de sync
--     gedraaid heeft, ook al was de waarde ongewijzigd).
--
-- Argument: p_pairs is een jsonb-array van {external_id, dealstage_raw}.
-- Returns: aantal effectief gewijzigde rijen.
CREATE OR REPLACE FUNCTION public.bulk_update_dealstage(
  p_project_id uuid,
  p_pairs      jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changed integer := 0;
BEGIN
  IF p_pairs IS NULL OR jsonb_typeof(p_pairs) <> 'array' THEN
    RETURN 0;
  END IF;

  WITH input AS (
    SELECT
      (elem->>'external_id')::text   AS external_id,
      (elem->>'dealstage_raw')::text AS dealstage_raw
    FROM jsonb_array_elements(p_pairs) AS elem
    WHERE elem->>'external_id'   IS NOT NULL
      AND elem->>'dealstage_raw' IS NOT NULL
  ),
  updated AS (
    UPDATE public.call_records cr
    SET
      dealstage_raw           = i.dealstage_raw,
      dealstage_synced_at     = now(),
      -- Reset classification ALLEEN als de raw-waarde anders is.
      dealstage_classified_at = CASE
        WHEN cr.dealstage_raw IS DISTINCT FROM i.dealstage_raw THEN NULL
        ELSE cr.dealstage_classified_at
      END,
      dealstage_category      = CASE
        WHEN cr.dealstage_raw IS DISTINCT FROM i.dealstage_raw THEN NULL
        ELSE cr.dealstage_category
      END
    FROM input i
    WHERE cr.project_id  = p_project_id
      AND cr.external_id = i.external_id
      AND cr.status ILIKE ANY (ARRAY['%afspraak%', '%appointment%'])
    RETURNING cr.id
  )
  SELECT count(*) INTO v_changed FROM updated;

  RETURN v_changed;
END $$;

REVOKE ALL ON FUNCTION public.bulk_update_dealstage(uuid, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.bulk_update_dealstage(uuid, jsonb) TO authenticated, service_role;


NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS public.idx_call_records_dealstage_unclassified;
-- ALTER TABLE public.call_records
--   DROP CONSTRAINT IF EXISTS call_records_dealstage_category_check,
--   DROP COLUMN     IF EXISTS dealstage_classified_at,
--   DROP COLUMN     IF EXISTS dealstage_synced_at,
--   DROP COLUMN     IF EXISTS dealstage_category,
--   DROP COLUMN     IF EXISTS dealstage_raw;
-- -- en daarna de oude view-definitie uit 2026-04-28_caller_id_in_views.sql opnieuw inzetten.
