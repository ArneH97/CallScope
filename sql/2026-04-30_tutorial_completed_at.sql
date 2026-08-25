-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: tutorial_completed_at op profiles
-- Datum:    2026-04-30
-- Reden:    Bij eerste login wil CallScope een rol-specifieke welkomst-modal
--           tonen om gebruikers door de eerste stappen te begeleiden. Zodra
--           ze de modal afronden of skippen, slaan we een timestamp op zodat
--           we weten dat het al gebeurd is.
--
--           NULL  = nog nooit gezien
--           value = afgerond of geskipt op die datum
--           Reset (NULL maken) zodat user de modal opnieuw kan zien.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS tutorial_completed_at timestamptz;

COMMENT ON COLUMN public.profiles.tutorial_completed_at IS
  'Wanneer de gebruiker de welkomst-tutorial heeft afgerond/geskipt. NULL = nog tonen.';

-- Backfill: bestaande gebruikers (die al ervaren zijn met de app) krijgen
-- automatisch een timestamp zodat ze de welkomst-modal niet voorgeschoteld
-- krijgen. Alleen nieuwe registraties (waar de profile NULL blijft tot
-- expliciet gezet) zien de tutorial.
UPDATE public.profiles
SET tutorial_completed_at = now()
WHERE tutorial_completed_at IS NULL;

NOTIFY pgrst, 'reload schema';
