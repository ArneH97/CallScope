-- ────────────────────────────────────────────────────────────────────────────
-- Multi Google Sheets per cold caller
--
-- Achtergrond: tot nu toe hadden we UNIQUE (project_id, caller_id) op
-- project_google_sheets → één sheet per caller per project. Bij RestoManager
-- (en toekomstige klanten) belt een cold caller uit meerdere sheets tegelijk
-- (bv. West-Vlaanderen + Antwerpen). Deze migratie laat meerdere sheet-
-- bindings per caller toe.
--
-- Nieuwe dedup-regel: dezelfde sheet mag maar één keer aan dezelfde caller
-- gekoppeld zijn — anders zou dezelfde data tweemaal binnen worden gesynct.
-- Dus de nieuwe UNIQUE = (project_id, caller_id, spreadsheet_id, sheet_name).
--
-- Idempotent: bij hergebruik gebeurt er niks (constraints worden alleen
-- gedropt/aangemaakt als ze nog niet in de gewenste staat zijn).
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Drop de oude single-sheet constraint. In deze DB heet die concreet
--    `project_google_sheets_project_caller_unique` (custom naam uit
--    2026-04-29 migratie). De andere twee namen zijn defensief voor DBs
--    waar Postgres 'm autonaam gaf — allemaal safe met IF EXISTS.
ALTER TABLE public.project_google_sheets
  DROP CONSTRAINT IF EXISTS project_google_sheets_project_caller_unique;
ALTER TABLE public.project_google_sheets
  DROP CONSTRAINT IF EXISTS project_google_sheets_project_id_caller_id_key;
ALTER TABLE public.project_google_sheets
  DROP CONSTRAINT IF EXISTS project_google_sheets_pkey_caller;

-- 2. Voeg de nieuwe constraint toe — dedup op sheet-niveau i.p.v. caller-niveau
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_google_sheets_uniq_binding'
  ) THEN
    ALTER TABLE public.project_google_sheets
      ADD CONSTRAINT project_google_sheets_uniq_binding
        UNIQUE (project_id, caller_id, spreadsheet_id, sheet_name);
  END IF;
END $$;

-- 3. Index voor de veelgebruikte lookup "alle sheets van deze caller"
CREATE INDEX IF NOT EXISTS project_google_sheets_caller_idx
  ON public.project_google_sheets (project_id, caller_id);

-- 4. Verificatie — toon huidige constraints + hoeveel rijen per caller
SELECT
  'constraints' AS what,
  string_agg(conname, ', ') AS value
  FROM pg_constraint
 WHERE conrelid = 'public.project_google_sheets'::regclass
UNION ALL
SELECT
  'bindings per caller (top 5)',
  string_agg(caller_id::text || ' → ' || cnt::text, ', ')
  FROM (
    SELECT caller_id, COUNT(*) AS cnt
      FROM public.project_google_sheets
     GROUP BY caller_id
     ORDER BY cnt DESC
     LIMIT 5
  ) sub;

COMMIT;
