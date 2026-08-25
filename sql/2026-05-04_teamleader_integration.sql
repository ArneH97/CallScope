-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: Teamleader integratie tabellen
-- Datum:    2026-05-04
-- Reden:    Sales managers koppelen hun Teamleader-account aan CallScope.
--           Voor elke afspraak op één van hun projecten zoekt de dagelijkse
--           cron op email (of telefoon) in Teamleader, vindt de bijhorende
--           deal en werkt de dealstage bij in CallScope.
--
--           Volgt exact hetzelfde patroon als hubspot_integrations zodat een
--           sales_manager beide CRMs kan koppelen als hij voor verschillende
--           klanten in verschillende systemen werkt.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.teamleader_integrations (
  user_id                 uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  refresh_token           text NOT NULL,
  access_token            text,
  expires_at              timestamptz,
  teamleader_account_id   text,                                       -- Teamleader account UUID (Focus: company-level)
  teamleader_account_name text,                                       -- account-naam (display)
  teamleader_user_email   text,                                       -- email van de Teamleader-user die geautoriseerd heeft
  connected_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.teamleader_integrations ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.teamleader_integrations');

-- Users zien/wijzigen alleen hun eigen integratie.
CREATE POLICY "teamleader_int_select_own" ON public.teamleader_integrations
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "teamleader_int_insert_own" ON public.teamleader_integrations
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE POLICY "teamleader_int_update_own" ON public.teamleader_integrations
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "teamleader_int_delete_own" ON public.teamleader_integrations
  FOR DELETE TO authenticated USING (user_id = auth.uid());


-- Cache: Teamleader deal-id op call_records — zelfde patroon als hubspot_deal_id.
ALTER TABLE public.call_records
  ADD COLUMN IF NOT EXISTS teamleader_deal_id text;

CREATE INDEX IF NOT EXISTS idx_call_records_teamleader_deal
  ON public.call_records (teamleader_deal_id)
  WHERE teamleader_deal_id IS NOT NULL;


NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS public.idx_call_records_teamleader_deal;
-- ALTER TABLE public.call_records DROP COLUMN IF EXISTS teamleader_deal_id;
-- DROP TABLE IF EXISTS public.teamleader_integrations;
