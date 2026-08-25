-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: voeg caller_id toe aan uploads + appointments_with_feedback
-- Datum:    2026-04-28
-- Reden:    Frontend matchte feedback aan callers via caller_name (fragiel:
--           dubbele namen, name changes). We willen op caller_id matchen.
--           Stappen:
--             1) caller_id kolom op uploads toevoegen (FK naar profiles)
--             2) View appointments_with_feedback uitbreiden met caller_id
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Kolom toevoegen aan uploads --------------------------------------------
--    Idempotent — werkt ook als er al uploads-rijen zijn (kolom is nullable).
ALTER TABLE public.uploads
  ADD COLUMN IF NOT EXISTS caller_id UUID REFERENCES public.profiles(id);

-- Optioneel: index voor de hot path (caller_id + project_id filter)
CREATE INDEX IF NOT EXISTS idx_uploads_caller_project
  ON public.uploads (caller_id, project_id);


-- 2. (Optioneel) backfill ----------------------------------------------------
--    Historische uploads hebben caller_id NULL. Als jouw uploads-tabel een
--    andere kolom had die de uploader bevatte (bv. user_id, uploaded_by) kan
--    je hier backfillen. Voorbeeld — pas aan of skip:
--
--    UPDATE public.uploads
--    SET    caller_id = uploaded_by
--    WHERE  caller_id IS NULL
--      AND  uploaded_by IS NOT NULL;


-- 3. View vervangen ---------------------------------------------------------
DROP VIEW IF EXISTS public.appointments_with_feedback CASCADE;

CREATE VIEW public.appointments_with_feedback AS
SELECT
  cr.id              AS call_record_id,
  cr.lead_name       AS lead_name,
  cr.call_date       AS call_date,
  cr.notes           AS caller_notes,

  u.project_id       AS project_id,
  u.call_center_id   AS call_center_id,
  cc.name            AS call_center_name,

  u.caller_id        AS caller_id,           -- ← nieuw
  caller.full_name   AS caller_name,

  af.appointment_status,
  af.outcome,
  af.quality_rating,
  af.notes              AS sales_notes,
  af.appointment_date,

  af.sales_rep_id,
  sales_rep.full_name   AS sales_rep_name
FROM public.call_records cr
JOIN public.uploads      u         ON u.id  = cr.upload_id
JOIN public.call_centers cc        ON cc.id = u.call_center_id
LEFT JOIN public.profiles caller    ON caller.id    = u.caller_id     -- LEFT JOIN: caller_id mag NULL zijn op oude rijen
LEFT JOIN public.appointment_feedback af        ON af.call_record_id = cr.id
LEFT JOIN public.profiles            sales_rep  ON sales_rep.id      = af.sales_rep_id
WHERE cr.status ILIKE ANY (ARRAY['%afspraak%', '%appointment%'])
   OR af.id IS NOT NULL;


-- 4. Permissions -------------------------------------------------------------
GRANT SELECT ON public.appointments_with_feedback TO anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS public.idx_uploads_caller_project;
-- ALTER TABLE public.uploads DROP COLUMN IF EXISTS caller_id;
-- DROP VIEW  IF EXISTS public.appointments_with_feedback CASCADE;
-- -- en dan de oude view-definitie er weer in.
