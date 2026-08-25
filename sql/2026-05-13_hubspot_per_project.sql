-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: HubSpot OAuth per PROJECT i.p.v. per user
-- Datum:    2026-05-13
-- Reden:    Eén cc_manager beheert vaak meerdere klanten — elke klant heeft
--           hun eigen HubSpot-portaal. De huidige per-user koppeling
--           (hubspot_integrations.user_id PK) kan dus maar één HubSpot-account
--           tegelijk handelen. We voegen een per-project koppeling toe:
--           elk CallScope-project mag zijn eigen HubSpot OAuth-tokens hebben.
--
--           Architectuur na deze migratie:
--             - hubspot_integrations            (user-level) → blijft voor
--                 sales_manager dealstage-sync (deal-stages → outcome).
--             - project_hubspot_integrations    (project-level) → NIEUW,
--                 gebruikt voor calls-sync (HubSpot lists + call engagements).
--                 Eén rij per project. cc_manager kan per project een ander
--                 HubSpot-portaal koppelen.
--             - projects.hubspot_calls_synced_by → blijft staan voor backwards
--                 compat van bestaande syncs; nieuwe code leest uit
--                 project_hubspot_integrations.
--
--           Backfill: voor elk project met hubspot_calls_list_id != NULL én
--           een matchende hubspot_integrations-rij (op hubspot_calls_synced_by)
--           kopiëren we de tokens naar project_hubspot_integrations zodat de
--           bestaande klanten zonder onderbreking blijven syncen.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Nieuwe tabel — project-scoped OAuth tokens ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.project_hubspot_integrations (
  project_id           uuid PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  refresh_token        text NOT NULL,
  access_token         text,
  expires_at           timestamptz,
  hubspot_account_id   text,                                          -- HubSpot's hub_id (numeric, opgeslagen als text)
  hubspot_account_name text,                                          -- HubSpot's portal-naam (display)
  hubspot_user_email   text,                                          -- email van de HubSpot user die geautoriseerd heeft
  connected_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  connected_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.project_hubspot_integrations ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.project_hubspot_integrations');

-- Helper: is de huidige user cc_manager van het call_center waaraan dit
-- project gekoppeld is? Alleen die persoon mag de HubSpot-koppeling beheren.
-- (Inline expressie i.p.v. aparte SQL-functie — past beter bij bestaande
-- RLS-stijl op andere projects-gerelateerde tabellen.)
CREATE POLICY "phi_select_own" ON public.project_hubspot_integrations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = project_hubspot_integrations.project_id
        AND cc.manager_id  = auth.uid()
    )
  );

CREATE POLICY "phi_insert_own" ON public.project_hubspot_integrations
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = project_hubspot_integrations.project_id
        AND cc.manager_id  = auth.uid()
    )
  );

CREATE POLICY "phi_update_own" ON public.project_hubspot_integrations
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = project_hubspot_integrations.project_id
        AND cc.manager_id  = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = project_hubspot_integrations.project_id
        AND cc.manager_id  = auth.uid()
    )
  );

CREATE POLICY "phi_delete_own" ON public.project_hubspot_integrations
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = project_hubspot_integrations.project_id
        AND cc.manager_id  = auth.uid()
    )
  );

-- 2. Backfill — bestaande project-koppelingen overzetten ────────────────────
-- Voor elk project met hubspot_calls_list_id én een hubspot_integrations-rij
-- van de hubspot_calls_synced_by user: kopieer die tokens naar de project-
-- tabel zodat de bestaande sync zonder onderbreking blijft werken.
INSERT INTO public.project_hubspot_integrations (
  project_id, refresh_token, access_token, expires_at,
  hubspot_account_id, hubspot_account_name, hubspot_user_email,
  connected_by, connected_at
)
SELECT
  p.id,
  hi.refresh_token,
  hi.access_token,
  hi.expires_at,
  hi.hubspot_account_id,
  hi.hubspot_account_name,
  hi.hubspot_user_email,
  hi.user_id,
  hi.connected_at
FROM public.projects p
JOIN public.hubspot_integrations hi ON hi.user_id = p.hubspot_calls_synced_by
WHERE p.hubspot_calls_list_id IS NOT NULL
ON CONFLICT (project_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public.project_hubspot_integrations;
