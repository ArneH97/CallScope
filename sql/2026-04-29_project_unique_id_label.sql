-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: unique_id_label op projects
-- Datum:    2026-04-29
-- Reden:    Welke kolom uit de bron-data als unieke sleutel (external_id) telt,
--           moet per project vastliggen. Anders krijg je chaos: upload 1 mapt
--           'phone' → external_id = "32468..." ; upload 2 mapt 'leBusinessId'
--           → external_id = "ChIJ..." → dezelfde lead, andere external_id, geen
--           dedup mogelijk.
--           Door de gekozen kolomnaam op het project te bewaren:
--             - Eerste upload bepaalt de keuze (en stuurt 'm naar dit veld)
--             - Volgende uploads krijgen de keuze pre-filled + locked
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS unique_id_label TEXT;


-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- ALTER TABLE public.projects DROP COLUMN IF EXISTS unique_id_label;
