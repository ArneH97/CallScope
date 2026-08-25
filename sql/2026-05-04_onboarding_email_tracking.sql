-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: tracking-kolommen voor onboarding-mailsequence
-- Datum:    2026-05-04
-- Reden:    Voorkomen dat we dezelfde welkomstmail / tip-mail / trial-reminder
--           dubbel verzenden. Elk kolom NULL = nog niet verzonden, ingevuld =
--           wel al verstuurd op die timestamp.
-- ────────────────────────────────────────────────────────────────────────────

-- Per-user tracking
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS welcome_email_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS tip_email_sent_at     timestamptz;

-- Per-project tracking voor trial-reminder
-- (ook al heeft de cc_manager meerdere projecten, we willen per project één
--  reminder kunnen sturen — niet één globale per user.)
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS trial_reminder_sent_at timestamptz;


NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS welcome_email_sent_at;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS tip_email_sent_at;
-- ALTER TABLE public.projects DROP COLUMN IF EXISTS trial_reminder_sent_at;
