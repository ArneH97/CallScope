-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: is_freelance flag op profiles
-- Datum:    2026-04-28
-- Reden:    Freelance appointment setters zijn cc_managers met een call_center
--           van 1 persoon (henzelf). De flag laat de UI toe een toggle te
--           tonen tussen Team-view en persoonlijke (cold-caller) view.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_freelance BOOLEAN NOT NULL DEFAULT FALSE;

-- Optioneel: index voor snelle filter (waarschijnlijk niet nodig op kleine tabel)
CREATE INDEX IF NOT EXISTS idx_profiles_is_freelance
  ON public.profiles (is_freelance) WHERE is_freelance = TRUE;

-- ROLLBACK:
-- DROP INDEX  IF EXISTS public.idx_profiles_is_freelance;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS is_freelance;
