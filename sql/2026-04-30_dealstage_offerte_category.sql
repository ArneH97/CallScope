-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: dealstage_category 'offerte' toevoegen aan toegestane waardes
-- Datum:    2026-04-30
-- Reden:    "Offerte" is een eigen outcome in CallScope (niet hetzelfde als
--           generieke follow-up). De AI classifier krijgt nu een aparte
--           categorie zodat de mapping naar appointment_feedback.outcome
--           correct kan zijn.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.call_records
  DROP CONSTRAINT IF EXISTS call_records_dealstage_category_check;

ALTER TABLE public.call_records
  ADD CONSTRAINT call_records_dealstage_category_check
  CHECK (
    dealstage_category IS NULL
    OR dealstage_category IN ('won','lost','offerte','in_progress','no_show','other')
  );

NOTIFY pgrst, 'reload schema';
