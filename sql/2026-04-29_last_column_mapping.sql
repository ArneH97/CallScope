-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: onthoud laatste kolom-mapping per project
-- Datum:    2026-04-29
-- Reden:    Bij elke upload moest de gebruiker handmatig de standaard-velden
--           (Naam lead, Status, Datum, Notities, Duur) opnieuw kiezen — de
--           heuristic auto-detect raadde niet altijd juist (bv. user koos
--           "Email" voor Naam lead, maar de heuristic pakt die niet op).
--
--           We slaan de gebruikte mapping op per project zodat volgende
--           uploads diezelfde kolommen pre-selecteren als ze ook bestaan in
--           het nieuwe bestand.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS last_column_mapping jsonb NOT NULL DEFAULT '{}'::jsonb;

NOTIFY pgrst, 'reload schema';
