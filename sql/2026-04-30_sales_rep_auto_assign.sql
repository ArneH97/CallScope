-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: Auto-toewijzing van sales rep aan afspraken via Google Sheets
-- Datum:    2026-04-30
-- Reden:    De sheet bevat per afspraak een "Sales rep"-kolom (typisch een
--           voornaam zoals "Arne"). We resolven die naam naar een sales_rep
--           user-id en upserten een minimale appointment_feedback-rij zodat:
--             - de sales rep z'n afspraak in zijn dashboard ziet
--             - sales managers weten wie verantwoordelijk is
--           Sync gebeurt namens de cc_manager (service_role) → RLS bypass.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Raw naam-kolom op call_records ────────────────────────────────────────
-- Slaan we altijd op, ook als de naam (nog) niet matcht met een user.
-- Geeft transparantie + zorgt dat we later kunnen re-resolven als de user
-- pas later z'n account aanmaakt.
ALTER TABLE public.call_records
  ADD COLUMN IF NOT EXISTS raw_sales_rep_name text;


-- 2. bulk_update_dealstage uitbreiden zodat ook raw_sales_rep_name geschreven
-- wordt in dezelfde call. Pairs zijn nu {external_id, dealstage_raw, sales_rep_name}.
-- (sales_rep_name is optioneel — als ontbreekt blijft kolom op huidige waarde)
DROP FUNCTION IF EXISTS public.bulk_update_dealstage(uuid, jsonb);

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
      (elem->>'external_id')::text     AS external_id,
      (elem->>'dealstage_raw')::text   AS dealstage_raw,
      NULLIF(elem->>'sales_rep_name','') AS sales_rep_name
    FROM jsonb_array_elements(p_pairs) AS elem
    WHERE elem->>'external_id' IS NOT NULL
  ),
  updated AS (
    UPDATE public.call_records cr
    SET
      dealstage_raw           = COALESCE(i.dealstage_raw, cr.dealstage_raw),
      raw_sales_rep_name      = COALESCE(i.sales_rep_name, cr.raw_sales_rep_name),
      dealstage_synced_at     = CASE
        WHEN i.dealstage_raw IS NOT NULL THEN now()
        ELSE cr.dealstage_synced_at
      END,
      dealstage_classified_at = CASE
        WHEN i.dealstage_raw IS NOT NULL
         AND cr.dealstage_raw IS DISTINCT FROM i.dealstage_raw
        THEN NULL
        ELSE cr.dealstage_classified_at
      END,
      dealstage_category      = CASE
        WHEN i.dealstage_raw IS NOT NULL
         AND cr.dealstage_raw IS DISTINCT FROM i.dealstage_raw
        THEN NULL
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


-- 3. RPC: bulk_assign_sales_rep ─────────────────────────────────────────────
-- Voor elk pair {external_id, sales_rep_id}: zoek de bijhorende call_record
-- (met afspraak-status), en upsert appointment_feedback met die sales_rep_id.
-- Defaults: appointment_status = 'gepland', outcome = 'geen'.
-- Bij conflict (al feedback) → enkel sales_rep_id updaten, andere velden
-- (status, notes, rating) blijven onaangeroerd zodat eerder sales-rep input
-- niet overschreven wordt.
CREATE OR REPLACE FUNCTION public.bulk_assign_sales_rep(
  p_project_id uuid,
  p_pairs      jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_assigned integer := 0;
BEGIN
  IF p_pairs IS NULL OR jsonb_typeof(p_pairs) <> 'array' THEN
    RETURN 0;
  END IF;

  WITH input AS (
    SELECT
      (elem->>'external_id')::text  AS external_id,
      (elem->>'sales_rep_id')::uuid AS sales_rep_id
    FROM jsonb_array_elements(p_pairs) AS elem
    WHERE elem->>'external_id'   IS NOT NULL
      AND elem->>'sales_rep_id'  IS NOT NULL
  ),
  call_record_match AS (
    -- Per (project, external_id, afspraak-status) → 1 of meerdere call_records.
    -- We pakken altijd het meest recente; voor één lead die meerdere keren
    -- gebeld werd (en op een latere call afspraak gemaakt) is dat de juiste rij.
    SELECT DISTINCT ON (cr.project_id, cr.external_id)
      cr.id           AS call_record_id,
      cr.external_id,
      i.sales_rep_id
    FROM public.call_records cr
    JOIN input i ON i.external_id = cr.external_id
    WHERE cr.project_id = p_project_id
      AND cr.status ILIKE ANY (ARRAY['%afspraak%', '%appointment%'])
    ORDER BY cr.project_id, cr.external_id, cr.call_date DESC NULLS LAST, cr.created_at DESC
  ),
  inserted AS (
    INSERT INTO public.appointment_feedback
      (call_record_id, sales_rep_id, appointment_status, outcome)
    SELECT
      m.call_record_id,
      m.sales_rep_id,
      'gepland'::text,
      'geen'::text
    FROM call_record_match m
    ON CONFLICT (call_record_id) DO UPDATE
      -- Alleen sales_rep_id overschrijven; status/notes/rating respecteren.
      SET sales_rep_id = EXCLUDED.sales_rep_id,
          updated_at   = now()
    RETURNING id
  )
  SELECT count(*) INTO v_assigned FROM inserted;

  RETURN v_assigned;
END $$;

REVOKE ALL ON FUNCTION public.bulk_assign_sales_rep(uuid, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.bulk_assign_sales_rep(uuid, jsonb) TO authenticated, service_role;


NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS public.bulk_assign_sales_rep(uuid, jsonb);
-- ALTER TABLE public.call_records DROP COLUMN IF EXISTS raw_sales_rep_name;
-- -- Re-create de oude bulk_update_dealstage uit 2026-04-30_dealstage.sql.
