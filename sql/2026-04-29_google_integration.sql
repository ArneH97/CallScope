-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: Google Sheets integratie tabellen
-- Datum:    2026-04-29
-- Reden:    Per gebruiker OAuth-tokens opslaan + per project een gekoppelde
--           Google Sheet (spreadsheet_id + tab) zodat we op een vast tijdstip
--           dagelijks kunnen syncen.
-- ────────────────────────────────────────────────────────────────────────────

-- 0. Helper-functie (kan zijn dat de RLS-reset 'm gedropt heeft) ──────────
CREATE OR REPLACE FUNCTION public._drop_all_policies(p_table regclass)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT polname FROM pg_policy WHERE polrelid = p_table
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', r.polname, p_table::text);
  END LOOP;
END $$;


-- 1. Per-user OAuth tokens ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.google_integrations (
  user_id        uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  refresh_token  text NOT NULL,
  access_token   text,
  expires_at     timestamptz,
  google_email   text,
  connected_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.google_integrations ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.google_integrations');

-- Users zien alleen hun eigen integratie. Tokens zijn gevoelig — server-side
-- gebruiken we service_role voor refresh-flow, client-side leest enkel om de
-- connected-state te tonen.
CREATE POLICY "google_int_select_own" ON public.google_integrations
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "google_int_insert_own" ON public.google_integrations
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE POLICY "google_int_update_own" ON public.google_integrations
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "google_int_delete_own" ON public.google_integrations
  FOR DELETE TO authenticated USING (user_id = auth.uid());


-- 2. Per-project per-caller sheet-binding ──────────────────────────────────
-- Eén sheet per cold caller per project. CC manager bindt elke caller's sheet
-- via de project-settings pagina. Sync gebeurt namens de cc_manager (zijn
-- Google account heeft toegang tot alle sheets).
CREATE TABLE IF NOT EXISTS public.project_google_sheets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  caller_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  spreadsheet_id    text NOT NULL,
  sheet_name        text NOT NULL,
  sheet_url         text,
  last_synced_at    timestamptz,
  last_sync_status  text,
  last_sync_error   text,
  created_by        uuid REFERENCES auth.users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- 1 sheet per caller per project
  UNIQUE (project_id, caller_id)
);

ALTER TABLE public.project_google_sheets ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.project_google_sheets');

CREATE POLICY "pgs_select_member" ON public.project_google_sheets
  FOR SELECT TO authenticated
  USING (public.has_project_access(project_google_sheets.project_id));

CREATE POLICY "pgs_insert_cc_manager" ON public.project_google_sheets
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND public.is_cc_manager_of_project(project_id)
  );

CREATE POLICY "pgs_update_cc_manager" ON public.project_google_sheets
  FOR UPDATE TO authenticated
  USING (public.is_cc_manager_of_project(project_id))
  WITH CHECK (public.is_cc_manager_of_project(project_id));

CREATE POLICY "pgs_delete_cc_manager" ON public.project_google_sheets
  FOR DELETE TO authenticated
  USING (public.is_cc_manager_of_project(project_id));


NOTIFY pgrst, 'reload schema';
