-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: HubSpot engagement-id unique index — verwijder WHERE-predicate
-- Datum:    2026-05-13
-- Reden:    De originele index op call_records (project_id, hubspot_call_engagement_id)
--           was partial: `WHERE hubspot_call_engagement_id IS NOT NULL`.
--
--           Supabase's PostgREST upsert met `onConflict: 'col1,col2'` genereert
--           een eenvoudig `ON CONFLICT (col1, col2)` — zonder WHERE-clause.
--           PostgreSQL eist dat de aangewezen unique constraint exact matcht,
--           dus een partial index wordt niet als doelwit erkend → 42P10:
--           "there is no unique or exclusion constraint matching the ON
--           CONFLICT specification".
--
--           Fix: zelfde index zonder WHERE. PostgreSQL behandelt NULL-waarden
--           in unique indexes als distinct, dus meerdere rijen met
--           hubspot_call_engagement_id = NULL veroorzaken nog steeds geen
--           conflict — exact het gedrag dat we wilden van de partial index.
-- ────────────────────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS public.ux_call_records_hubspot_engagement;

CREATE UNIQUE INDEX IF NOT EXISTS ux_call_records_hubspot_engagement
  ON public.call_records (project_id, hubspot_call_engagement_id);

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS public.ux_call_records_hubspot_engagement;
-- CREATE UNIQUE INDEX IF NOT EXISTS ux_call_records_hubspot_engagement
--   ON public.call_records (project_id, hubspot_call_engagement_id)
--   WHERE hubspot_call_engagement_id IS NOT NULL;
