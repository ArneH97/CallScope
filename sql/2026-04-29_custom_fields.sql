-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: custom fields op call_records + projects
-- Datum:    2026-04-29
-- Reden:    Gebruikers willen extra projectspecifieke velden kunnen mappen
--           bij upload (bv. deal_value, source, event_type). Tot 3 velden,
--           4 types: text, number, date, category.
--
--           Storage:
--             - call_records.custom_fields (JSONB) — key/value paren per call
--             - projects.custom_field_definitions (JSONB) — schema per project
--
--           Het schema (definitions) wordt opgeslagen op het project zodat
--           volgende uploads dezelfde mapping kunnen hergebruiken.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. call_records.custom_fields ──────────────────────────────────────────────
ALTER TABLE public.call_records
  ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 2. projects.custom_field_definitions ──────────────────────────────────────
-- Voorbeeld waarde:
-- [
--   { "key": "deal_value",  "label": "Deal waarde", "type": "number" },
--   { "key": "source",      "label": "Bron",        "type": "category" },
--   { "key": "event_type",  "label": "Event type",  "type": "category" }
-- ]
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS custom_field_definitions jsonb NOT NULL DEFAULT '[]'::jsonb;

-- (Optioneel) GIN-index op custom_fields voor snelle zoekqueries later
CREATE INDEX IF NOT EXISTS idx_call_records_custom_fields
  ON public.call_records USING gin (custom_fields);

NOTIFY pgrst, 'reload schema';
