-- ────────────────────────────────────────────────────────────────────────────
-- RLS-policies voor projecten / call_centers / membership
-- Datum:    2026-04-28
-- Reden:    cc_managers krijgen "new row violates row-level security policy"
--           bij het aanmaken van een project. We zetten een complete policy-
--           set die past bij de app-flows.
--
-- LET OP:   Run dit bestand pas nadat je de output van de pg_policies-query
--           hebt bekeken — je hebt mogelijk al policies met andere namen die
--           je niet wil dupliceren. De drops onderaan elke sectie zijn
--           idempotent (DROP POLICY IF EXISTS).
-- ────────────────────────────────────────────────────────────────────────────

-- Helper: alle relevante tabellen krijgen RLS aan (no-op als 't al aan staat)
ALTER TABLE public.projects             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_centers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_center_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_call_centers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_members      ENABLE ROW LEVEL SECURITY;


-- ── projects ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "projects_select_authenticated" ON public.projects;
DROP POLICY IF EXISTS "projects_insert_cc_manager"    ON public.projects;
DROP POLICY IF EXISTS "projects_update_cc_manager"    ON public.projects;
DROP POLICY IF EXISTS "projects_delete_cc_manager"    ON public.projects;

-- Iedereen die ingelogd is mag projecten zien (de UI filtert verder zelf).
CREATE POLICY "projects_select_authenticated" ON public.projects
  FOR SELECT TO authenticated
  USING (true);

-- cc_managers mogen projecten aanmaken.
CREATE POLICY "projects_insert_cc_manager" ON public.projects
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.role = 'cc_manager'
    )
  );

-- cc_managers mogen projecten updaten (waar ze gelinkt aan zijn via project_call_centers).
CREATE POLICY "projects_update_cc_manager" ON public.projects
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = projects.id
        AND cc.manager_id = auth.uid()
    )
  );

CREATE POLICY "projects_delete_cc_manager" ON public.projects
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = projects.id
        AND cc.manager_id = auth.uid()
    )
  );


-- ── call_centers ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "call_centers_select_authenticated" ON public.call_centers;
DROP POLICY IF EXISTS "call_centers_insert_cc_manager"    ON public.call_centers;
DROP POLICY IF EXISTS "call_centers_update_manager"       ON public.call_centers;
DROP POLICY IF EXISTS "call_centers_delete_manager"       ON public.call_centers;

CREATE POLICY "call_centers_select_authenticated" ON public.call_centers
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "call_centers_insert_cc_manager" ON public.call_centers
  FOR INSERT TO authenticated
  WITH CHECK (
    manager_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'cc_manager'
    )
  );

CREATE POLICY "call_centers_update_manager" ON public.call_centers
  FOR UPDATE TO authenticated
  USING (manager_id = auth.uid());

CREATE POLICY "call_centers_delete_manager" ON public.call_centers
  FOR DELETE TO authenticated
  USING (manager_id = auth.uid());


-- ── call_center_members ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "ccm_select_authenticated" ON public.call_center_members;
DROP POLICY IF EXISTS "ccm_insert_manager"       ON public.call_center_members;
DROP POLICY IF EXISTS "ccm_delete_manager"       ON public.call_center_members;

CREATE POLICY "ccm_select_authenticated" ON public.call_center_members
  FOR SELECT TO authenticated
  USING (true);

-- Manager van het call_center mag members toevoegen, OF gebruikers mogen
-- zichzelf toevoegen aan een call_center waar ze de manager van zijn
-- (dat is de auto-setup voor freelancers).
CREATE POLICY "ccm_insert_manager" ON public.call_center_members
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.call_centers cc
      WHERE cc.id = call_center_members.call_center_id
        AND cc.manager_id = auth.uid()
    )
  );

CREATE POLICY "ccm_delete_manager" ON public.call_center_members
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.call_centers cc
      WHERE cc.id = call_center_members.call_center_id
        AND cc.manager_id = auth.uid()
    )
  );


-- ── project_call_centers ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "pcc_select_authenticated" ON public.project_call_centers;
DROP POLICY IF EXISTS "pcc_insert_manager"       ON public.project_call_centers;
DROP POLICY IF EXISTS "pcc_delete_manager"       ON public.project_call_centers;

CREATE POLICY "pcc_select_authenticated" ON public.project_call_centers
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "pcc_insert_manager" ON public.project_call_centers
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.call_centers cc
      WHERE cc.id = project_call_centers.call_center_id
        AND cc.manager_id = auth.uid()
    )
  );

CREATE POLICY "pcc_delete_manager" ON public.project_call_centers
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.call_centers cc
      WHERE cc.id = project_call_centers.call_center_id
        AND cc.manager_id = auth.uid()
    )
  );


-- ── project_members (sales reps op een project) ─────────────────────────────
DROP POLICY IF EXISTS "pm_select_authenticated" ON public.project_members;
DROP POLICY IF EXISTS "pm_insert_cc_manager"    ON public.project_members;
DROP POLICY IF EXISTS "pm_delete_cc_manager"    ON public.project_members;

CREATE POLICY "pm_select_authenticated" ON public.project_members
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "pm_insert_cc_manager" ON public.project_members
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = project_members.project_id
        AND cc.manager_id = auth.uid()
    )
  );

CREATE POLICY "pm_delete_cc_manager" ON public.project_members
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = project_members.project_id
        AND cc.manager_id = auth.uid()
    )
  );
