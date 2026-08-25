-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: voeg region-kolom toe aan lead_pool
-- Datum:    2026-05-27 (rev 2 — appointment-planner)
-- Reden:    RestoManager (en mogelijk andere BE-klanten) gebruiken
--           sub-regio's binnen een provincie. Voor West-Vlaanderen:
--           WVL-NW, WVL-W, WVL-M, WVL-Z. Een lead op postcode 8000 (Brugge)
--           moet matchen met een sales rep die "WVL-NW" in z'n Google
--           Calendar heeft staan, niet met eentje die enkel "WVL-W" doet.
--
--           Voor MVP is de WVL-mapping hardcoded in lib/regions.ts. Bij
--           geocoding wordt postal_code → region berekend en hier opgeslagen.
--           Andere provincies krijgen NULL en gebruiken alleen province-match.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.lead_pool
  ADD COLUMN IF NOT EXISTS region text;

CREATE INDEX IF NOT EXISTS idx_lead_pool_region
  ON public.lead_pool (project_id, region)
  WHERE region IS NOT NULL;

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- ALTER TABLE public.lead_pool DROP COLUMN IF EXISTS region;
