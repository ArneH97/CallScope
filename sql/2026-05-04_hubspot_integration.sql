-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: HubSpot integratie tabellen
-- Datum:    2026-05-04
-- Reden:    Sales managers koppelen hun HubSpot-portaal aan CallScope. Voor
--           elke afspraak op één van hun projecten zoekt de dagelijkse cron
--           op email (of telefoon) in HubSpot, vindt de bijhorende deal en
--           werkt de dealstage bij in CallScope.
--
--           - hubspot_integrations: per profile_id (sales_manager) tokens.
--             Eén integratie per profile. Cascade op delete via auth.users.
--           - call_records.hubspot_deal_id: cache van het laatst gevonden
--             HubSpot deal-id zodat volgende sync direct naar de deal gaat
--             (sneller en stabieler dan elke keer opnieuw zoeken).
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Per-user OAuth tokens ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.hubspot_integrations (
  user_id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  refresh_token        text NOT NULL,
  access_token         text,
  expires_at           timestamptz,
  hubspot_account_id   text,                                          -- HubSpot's hub_id (numeric, opgeslagen als text)
  hubspot_account_name text,                                          -- HubSpot's portal-naam (display)
  hubspot_user_email   text,                                          -- email van de HubSpot user die geautoriseerd heeft
  connected_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.hubspot_integrations ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.hubspot_integrations');

-- Users zien/wijzigen alleen hun eigen integratie. De cron en sync-routes
-- gebruiken service_role om over alle integraties heen te lopen.
CREATE POLICY "hubspot_int_select_own" ON public.hubspot_integrations
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "hubspot_int_insert_own" ON public.hubspot_integrations
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE POLICY "hubspot_int_update_own" ON public.hubspot_integrations
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "hubspot_int_delete_own" ON public.hubspot_integrations
  FOR DELETE TO authenticated USING (user_id = auth.uid());


-- 2. Cache: HubSpot deal-id op call_records ─────────────────────────────────
-- Eerste sync zoekt op email/telefoon → deal. Volgende sync gebruikt direct
-- het opgeslagen deal-id (idempotent + sneller). NULL = nog niet gematcht.
ALTER TABLE public.call_records
  ADD COLUMN IF NOT EXISTS hubspot_deal_id text;

-- Optionele index voor reverse-lookup vanuit cron
CREATE INDEX IF NOT EXISTS idx_call_records_hubspot_deal
  ON public.call_records (hubspot_deal_id)
  WHERE hubspot_deal_id IS NOT NULL;


NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS public.idx_call_records_hubspot_deal;
-- ALTER TABLE public.call_records DROP COLUMN IF EXISTS hubspot_deal_id;
-- DROP TABLE IF EXISTS public.hubspot_integrations;
