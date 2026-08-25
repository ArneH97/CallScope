-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: AI-gegenereerde inzichten over custom fields
-- Datum:    2026-04-29
-- Reden:    Fase 2 van custom fields. De AI-analyse leest naast status/notes
--           ook de custom_fields per call_record en genereert inzichten over
--           de verbanden (bv. "leads met offertewaarde > €100k converteren
--           2.3× vaker"). Die inzichten worden opgeslagen op analyses.
-- ────────────────────────────────────────────────────────────────────────────

-- Voorbeeld waarde:
-- [
--   {
--     "field_key": "offertewaarde",
--     "headline": "Hogere offertewaarde leidt tot meer afspraken",
--     "detail":   "Leads met een offertewaarde > €100k hebben een conversie van 50%, t.o.v. 20% bij leads onder €50k."
--   },
--   ...
-- ]
ALTER TABLE public.analyses
  ADD COLUMN IF NOT EXISTS custom_insights jsonb NOT NULL DEFAULT '[]'::jsonb;

NOTIFY pgrst, 'reload schema';
