-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: external_id + dedup op call_records
-- Datum:    2026-04-29
-- Reden:    Bij herhaalde uploads van een evolutielijst (bv. Google Sheet die
--           je dagelijks aanvult) moeten dezelfde leads herkend worden, niet
--           als nieuwe rijen worden behandeld. Wat:
--             1) external_id (TEXT) → unieke sleutel uit jouw bron-bestand
--                  (telefoonnummer / Google Place ID / CRM-id / ...)
--             2) project_id op call_records (denormalisatie) → nodig voor de
--                unique-index, want dedup is per project (lead X in project A
--                ≠ lead X in project B).
--             3) Unique index op (project_id, external_id, call_date) WHERE
--                external_id IS NOT NULL → 1 lead × 1 dag = 1 call.
--             4) Upsert in de upload-flow: zelfde combinatie → UPDATE i.p.v.
--                duplicaat. Nieuwe combinatie → INSERT.
--           Bestaande uploads (zonder external_id) blijven werken: de WHERE-
--           clausule sluit NULL-rijen uit van de unique-check.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Kolommen toevoegen ------------------------------------------------------
ALTER TABLE public.call_records
  ADD COLUMN IF NOT EXISTS external_id TEXT;

ALTER TABLE public.call_records
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id);


-- 2. Backfill project_id via uploads -----------------------------------------
UPDATE public.call_records cr
SET    project_id = u.project_id
FROM   public.uploads u
WHERE  cr.upload_id = u.id
  AND  cr.project_id IS NULL;

-- Maak project_id verplicht voor toekomstige inserts.
-- (Idempotent: als er nog NULL-rijen zijn, faalt deze stap. Run dan eerst stap 2
--  opnieuw. In de praktijk zou dit niet mogen gebeuren want elke call_record
--  is via upload_id gekoppeld aan een upload met een project_id.)
ALTER TABLE public.call_records
  ALTER COLUMN project_id SET NOT NULL;


-- 3. Unique constraint -------------------------------------------------------
-- BELANGRIJK: een named UNIQUE CONSTRAINT (niet enkel een unique index!), want
-- PostgREST (de Supabase REST-laag) herkent voor `?on_conflict=...` enkel
-- echte constraints, geen losse indexes. Een constraint maakt automatisch
-- ook een ondersteunende index aan, dus we krijgen beide voordelen.
-- NIET-partial: PostgreSQL behandelt NULL als 'altijd verschillend', dus
-- rijen zonder external_id blijven gewoon coëxisteren (oud gedrag).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'call_records_unique_call'
      AND conrelid = 'public.call_records'::regclass
  ) THEN
    -- Drop oude losse index als die er al was
    DROP INDEX IF EXISTS public.call_records_unique_call;
    ALTER TABLE public.call_records
      ADD CONSTRAINT call_records_unique_call
      UNIQUE (project_id, external_id, call_date);
  END IF;
END $$;

-- Hot path: filter op project_id + external_id (lead-historie ophalen)
CREATE INDEX IF NOT EXISTS idx_call_records_project_external
  ON public.call_records (project_id, external_id)
  WHERE external_id IS NOT NULL;

-- 4. PostgREST schema-cache forceren te herladen, zodat de nieuwe constraint
--    direct beschikbaar is voor on_conflict-resolving in upsert-calls.
NOTIFY pgrst, 'reload schema';


-- 4. Permissions blijven ongewijzigd; views joinen via call_records.id (niet
--    via project_id of external_id), dus geen view-rebuild nodig voor deze
--    migratie. upload_summary en appointments_with_feedback blijven werken.


-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS public.call_records_unique_call;
-- DROP INDEX IF EXISTS public.idx_call_records_project_external;
-- ALTER TABLE public.call_records DROP COLUMN IF EXISTS external_id;
-- ALTER TABLE public.call_records DROP COLUMN IF EXISTS project_id;
