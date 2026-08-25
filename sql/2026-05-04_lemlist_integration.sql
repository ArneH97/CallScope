-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: Lemlist integratie tabellen
-- Datum:    2026-05-04
-- Reden:    Cc_managers koppelen hun Lemlist-account via API-key (geen OAuth).
--           Per project kiezen ze één Lemlist-campaign als bron. Dagelijkse
--           cron pulled leads + call-activities en zet ze om naar call_records.
--
--           Eén API-key per cc_manager — die werkt over alle campaigns waar
--           de gebruiker toegang toe heeft in Lemlist.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Per-user API-key opslag ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lemlist_integrations (
  user_id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  api_key              text NOT NULL,                                  -- gevoelig: enkel server-side gebruiken
  lemlist_team_id      text,                                           -- team-id voor display
  lemlist_team_name    text,                                           -- bedrijfsnaam in Lemlist (voor UI)
  lemlist_user_email   text,                                           -- email van de gebruiker in Lemlist
  connected_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.lemlist_integrations ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.lemlist_integrations');

-- API-key is gevoelig: client-side mag enkel de eigen rij metadata zien
-- (bv. lemlist_team_name) — server-routes gebruiken service_role.
CREATE POLICY "lemlist_int_select_own" ON public.lemlist_integrations
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "lemlist_int_insert_own" ON public.lemlist_integrations
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE POLICY "lemlist_int_update_own" ON public.lemlist_integrations
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "lemlist_int_delete_own" ON public.lemlist_integrations
  FOR DELETE TO authenticated USING (user_id = auth.uid());


-- 2. Per-project Lemlist-campaign-binding ──────────────────────────────────
-- Welke Lemlist-campaign is de bron voor dit project? NULL = geen Lemlist-bron
-- (project gebruikt manuele upload of Google Sheets).
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS lemlist_campaign_id   text,
  ADD COLUMN IF NOT EXISTS lemlist_campaign_name text;                 -- cache voor display

-- Welke user's API-key gebruiken we voor de sync? Default: de cc_manager
-- van het call_center — maar we slaan het expliciet op om transparant te
-- zijn over wiens token gebruikt wordt.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS lemlist_synced_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;


-- 3. Cache: Lemlist-id's op call_records ────────────────────────────────────
-- lead_id: de oorspronkelijke Lemlist lead voor deze rij. external_id krijgt
--          dezelfde waarde voor backwards-compat met de bestaande dedup.
ALTER TABLE public.call_records
  ADD COLUMN IF NOT EXISTS lemlist_lead_id text;

CREATE INDEX IF NOT EXISTS idx_call_records_lemlist_lead
  ON public.call_records (lemlist_lead_id)
  WHERE lemlist_lead_id IS NOT NULL;


NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS public.idx_call_records_lemlist_lead;
-- ALTER TABLE public.call_records DROP COLUMN IF EXISTS lemlist_lead_id;
-- ALTER TABLE public.projects DROP COLUMN IF EXISTS lemlist_synced_by;
-- ALTER TABLE public.projects DROP COLUMN IF EXISTS lemlist_campaign_id;
-- ALTER TABLE public.projects DROP COLUMN IF EXISTS lemlist_campaign_name;
-- DROP TABLE IF EXISTS public.lemlist_integrations;
