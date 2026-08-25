-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: HubSpot CALLS-sync (cc_manager) — calls + leads vanuit HubSpot
-- Datum:    2026-05-05
-- Reden:    Naast de bestaande HubSpot-koppeling voor sales_managers (deals →
--           dealstages) willen cc_managers hun gemaakte calls ook in CallScope
--           binnenhalen. Sommige teams cold-callen rechtstreeks in HubSpot.
--
--           Architectuur:
--             - Eén hubspot_integrations-rij per user (bestaand). cc_manager
--               doet eigen OAuth — krijgt extra scopes calls.read + lists.read.
--             - Project-level: cc_manager kiest één HubSpot-list per project.
--               Calls op contacts uit die list worden gesynced.
--             - Caller-attributie: HubSpot-call.owner-email → match met
--               profiles.email → caller_id.
--             - Disposition (bv. "Connected", "Voicemail") wordt gemapt naar
--               CallScope-status.
--             - Dedup via call_records.hubspot_call_engagement_id.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Project-level: welke HubSpot-list = welk CallScope-project?
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS hubspot_calls_list_id    text,
  ADD COLUMN IF NOT EXISTS hubspot_calls_list_name  text,
  ADD COLUMN IF NOT EXISTS hubspot_calls_synced_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- 2. Per-call: HubSpot engagement-id voor dedup. Engagement-id is uniek binnen
--    HubSpot, dus we kunnen deze als idempotente sleutel gebruiken voor re-syncs.
ALTER TABLE public.call_records
  ADD COLUMN IF NOT EXISTS hubspot_call_engagement_id text;

-- Unieke index voor dedup-upsert. Zelfde idee als (project_id, external_id, call_date)
-- maar voor HubSpot-syncs gebruiken we de engagement_id direct (uniek by design).
CREATE UNIQUE INDEX IF NOT EXISTS ux_call_records_hubspot_engagement
  ON public.call_records (project_id, hubspot_call_engagement_id)
  WHERE hubspot_call_engagement_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS public.ux_call_records_hubspot_engagement;
-- ALTER TABLE public.call_records  DROP COLUMN IF EXISTS hubspot_call_engagement_id;
-- ALTER TABLE public.projects      DROP COLUMN IF EXISTS hubspot_calls_synced_by;
-- ALTER TABLE public.projects      DROP COLUMN IF EXISTS hubspot_calls_list_name;
-- ALTER TABLE public.projects      DROP COLUMN IF EXISTS hubspot_calls_list_id;
