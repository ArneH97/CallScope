-- ════════════════════════════════════════════════════════════════════════════
-- COMPREHENSIVE RLS RESET — schoon en consistent voor alle tabellen
-- Datum: 2026-04-29
--
-- Hoe te gebruiken: run dit hele bestand in één keer in Supabase SQL Editor.
-- Het wist alle bestaande RLS-policies op deze tabellen en zet er een nieuwe
-- consistente set voor in de plaats. Geen dataverlies — alleen policy-rules.
--
-- Het rolmodel:
--   - cc_manager: beheert zijn eigen call_center, projecten, uploads, calls.
--                 Mag iedereen aan/van zijn projecten toevoegen/verwijderen.
--   - cold_caller: doet uploads voor zichzelf op projecten waar hij/zij in zit.
--   - sales_rep: ziet projecten waar hij/zij expliciet aan toegevoegd is, geeft
--                feedback op afspraken.
--   - sales_manager: idem sales_rep + mag andere sales_reps aan/van project
--                    toevoegen op projecten waar hij/zij zelf op zit.
-- ════════════════════════════════════════════════════════════════════════════


-- ── HELPER FUNCTIES ───────────────────────────────────────────────────────

-- Heeft de current user toegang tot dit project?
-- Twee paden: (a) cc_manager via project_call_centers, (b) lid via project_members
CREATE OR REPLACE FUNCTION public.has_project_access(p_project_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_call_centers pcc
    JOIN public.call_centers cc ON cc.id = pcc.call_center_id
    WHERE pcc.project_id = p_project_id
      AND cc.manager_id  = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM public.project_members pm
    WHERE pm.project_id = p_project_id
      AND pm.profile_id = auth.uid()
  );
$$;
GRANT EXECUTE ON FUNCTION public.has_project_access(uuid) TO authenticated;

-- Is de current user de cc_manager van een call_center dat aan dit project hangt?
CREATE OR REPLACE FUNCTION public.is_cc_manager_of_project(p_project_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_call_centers pcc
    JOIN public.call_centers cc ON cc.id = pcc.call_center_id
    WHERE pcc.project_id = p_project_id
      AND cc.manager_id  = auth.uid()
  );
$$;
GRANT EXECUTE ON FUNCTION public.is_cc_manager_of_project(uuid) TO authenticated;


-- ── HELPER: drop alle bestaande policies op een tabel ─────────────────────
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


-- ── PROFILES ──────────────────────────────────────────────────────────────
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.profiles');

CREATE POLICY "profiles_select_all" ON public.profiles
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());

CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());


-- ── CALL_CENTERS ──────────────────────────────────────────────────────────
ALTER TABLE public.call_centers ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.call_centers');

CREATE POLICY "call_centers_select_all" ON public.call_centers
  FOR SELECT TO authenticated USING (true);

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
  FOR UPDATE TO authenticated USING (manager_id = auth.uid());

CREATE POLICY "call_centers_delete_manager" ON public.call_centers
  FOR DELETE TO authenticated USING (manager_id = auth.uid());


-- ── CALL_CENTER_MEMBERS ───────────────────────────────────────────────────
ALTER TABLE public.call_center_members ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.call_center_members');

CREATE POLICY "ccm_select_all" ON public.call_center_members
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "ccm_insert_manager_or_self" ON public.call_center_members
  FOR INSERT TO authenticated
  WITH CHECK (
    -- Manager mag iedereen toevoegen
    EXISTS (
      SELECT 1 FROM public.call_centers cc
      WHERE cc.id = call_center_members.call_center_id
        AND cc.manager_id = auth.uid()
    )
    -- Of: de freelance auto-setup voegt zichzelf toe aan eigen call_center
    OR (profile_id = auth.uid() AND EXISTS (
      SELECT 1 FROM public.call_centers cc
      WHERE cc.id = call_center_members.call_center_id
        AND cc.manager_id = auth.uid()
    ))
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


-- ── PROJECTS ──────────────────────────────────────────────────────────────
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.projects');

CREATE POLICY "projects_select_member" ON public.projects
  FOR SELECT TO authenticated
  USING (public.has_project_access(projects.id));

-- INSERT: cc_managers (de create_project RPC bypass dit via SECURITY DEFINER,
-- maar voor backwards-compatibiliteit met directe inserts laten we 't toe).
CREATE POLICY "projects_insert_cc_manager" ON public.projects
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'cc_manager')
  );

CREATE POLICY "projects_update_cc_manager" ON public.projects
  FOR UPDATE TO authenticated
  USING (public.is_cc_manager_of_project(projects.id))
  WITH CHECK (public.is_cc_manager_of_project(projects.id));

CREATE POLICY "projects_delete_cc_manager" ON public.projects
  FOR DELETE TO authenticated
  USING (public.is_cc_manager_of_project(projects.id));


-- ── PROJECT_CALL_CENTERS ──────────────────────────────────────────────────
ALTER TABLE public.project_call_centers ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.project_call_centers');

CREATE POLICY "pcc_select_member" ON public.project_call_centers
  FOR SELECT TO authenticated
  USING (public.has_project_access(project_call_centers.project_id));

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


-- ── PROJECT_MEMBERS ───────────────────────────────────────────────────────
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.project_members');

CREATE POLICY "pm_select_member" ON public.project_members
  FOR SELECT TO authenticated
  USING (
    profile_id = auth.uid()
    OR public.has_project_access(project_members.project_id)
  );

-- cc_manager mag elke rol toevoegen
CREATE POLICY "pm_insert_cc_manager" ON public.project_members
  FOR INSERT TO authenticated
  WITH CHECK (public.is_cc_manager_of_project(project_members.project_id));

-- sales_manager mag alleen sales_rep toevoegen op projecten waar hij/zij in zit
CREATE POLICY "pm_insert_sales_manager" ON public.project_members
  FOR INSERT TO authenticated
  WITH CHECK (
    project_members.role = 'sales_rep'
    AND EXISTS (
      SELECT 1 FROM public.project_members pm2
      WHERE pm2.project_id = project_members.project_id
        AND pm2.profile_id = auth.uid()
        AND pm2.role = 'sales_manager'
    )
  );

CREATE POLICY "pm_delete_cc_manager" ON public.project_members
  FOR DELETE TO authenticated
  USING (public.is_cc_manager_of_project(project_members.project_id));

CREATE POLICY "pm_delete_sales_manager" ON public.project_members
  FOR DELETE TO authenticated
  USING (
    project_members.role = 'sales_rep'
    AND EXISTS (
      SELECT 1 FROM public.project_members pm2
      WHERE pm2.project_id = project_members.project_id
        AND pm2.profile_id = auth.uid()
        AND pm2.role = 'sales_manager'
    )
  );


-- ── UPLOADS ───────────────────────────────────────────────────────────────
ALTER TABLE public.uploads ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.uploads');

CREATE POLICY "uploads_select_project" ON public.uploads
  FOR SELECT TO authenticated
  USING (public.has_project_access(uploads.project_id));

-- INSERT: caller voor zichzelf, of cc_manager
CREATE POLICY "uploads_insert_member" ON public.uploads
  FOR INSERT TO authenticated
  WITH CHECK (
    -- Caller voegt eigen upload toe (caller_id = self én lid van het call_center)
    (
      caller_id = auth.uid()
      AND EXISTS (
        SELECT 1 FROM public.call_center_members ccm
        WHERE ccm.call_center_id = uploads.call_center_id
          AND ccm.profile_id = auth.uid()
      )
    )
    -- Of cc_manager van het call_center (mag voor andere callers uploaden)
    OR EXISTS (
      SELECT 1 FROM public.call_centers cc
      WHERE cc.id = uploads.call_center_id
        AND cc.manager_id = auth.uid()
    )
  );

-- UPDATE: own upload (status updates) of cc_manager
CREATE POLICY "uploads_update_member" ON public.uploads
  FOR UPDATE TO authenticated
  USING (
    caller_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.call_centers cc
      WHERE cc.id = uploads.call_center_id
        AND cc.manager_id = auth.uid()
    )
  );

CREATE POLICY "uploads_delete_manager" ON public.uploads
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.call_centers cc
      WHERE cc.id = uploads.call_center_id
        AND cc.manager_id = auth.uid()
    )
  );


-- ── CALL_RECORDS ──────────────────────────────────────────────────────────
ALTER TABLE public.call_records ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.call_records');

CREATE POLICY "call_records_select_project" ON public.call_records
  FOR SELECT TO authenticated
  USING (public.has_project_access(call_records.project_id));

-- INSERT: via de upload — caller of cc_manager
CREATE POLICY "call_records_insert_member" ON public.call_records
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.uploads u
      WHERE u.id = call_records.upload_id
        AND (
          u.caller_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.call_centers cc
            WHERE cc.id = u.call_center_id
              AND cc.manager_id = auth.uid()
          )
        )
    )
  );

-- UPDATE: nodig voor upsert/dedup. Caller mag eigen rijen updaten + cc_manager.
CREATE POLICY "call_records_update_member" ON public.call_records
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.uploads u
      WHERE u.id = call_records.upload_id
        AND (
          u.caller_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.call_centers cc
            WHERE cc.id = u.call_center_id
              AND cc.manager_id = auth.uid()
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.uploads u
      WHERE u.id = call_records.upload_id
        AND (
          u.caller_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.call_centers cc
            WHERE cc.id = u.call_center_id
              AND cc.manager_id = auth.uid()
          )
        )
    )
  );

CREATE POLICY "call_records_delete_manager" ON public.call_records
  FOR DELETE TO authenticated
  USING (public.is_cc_manager_of_project(call_records.project_id));


-- ── ANALYSES ──────────────────────────────────────────────────────────────
ALTER TABLE public.analyses ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.analyses');

CREATE POLICY "analyses_select_project" ON public.analyses
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.uploads u
      WHERE u.id = analyses.upload_id
        AND public.has_project_access(u.project_id)
    )
  );

-- Geen INSERT/UPDATE/DELETE-policy voor authenticated — de AI-route gebruikt
-- service_role (bypasst RLS standaard). Authenticated mag alleen lezen.


-- ── APPOINTMENT_FEEDBACK ──────────────────────────────────────────────────
ALTER TABLE public.appointment_feedback ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.appointment_feedback');

CREATE POLICY "appt_fb_select_project" ON public.appointment_feedback
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.call_records cr
      WHERE cr.id = appointment_feedback.call_record_id
        AND public.has_project_access(cr.project_id)
    )
  );

CREATE POLICY "appt_fb_insert_sales" ON public.appointment_feedback
  FOR INSERT TO authenticated
  WITH CHECK (
    sales_rep_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('sales_rep', 'sales_manager')
    )
  );

CREATE POLICY "appt_fb_update_sales" ON public.appointment_feedback
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('sales_rep', 'sales_manager')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('sales_rep', 'sales_manager')
    )
  );

CREATE POLICY "appt_fb_delete_manager" ON public.appointment_feedback
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'sales_manager'
    )
  );


-- ── REPORT_SHARES ─────────────────────────────────────────────────────────
ALTER TABLE public.report_shares ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.report_shares');

CREATE POLICY "report_shares_select_creator" ON public.report_shares
  FOR SELECT TO authenticated
  USING (created_by = auth.uid() OR public.is_cc_manager_of_project(project_id));

CREATE POLICY "report_shares_insert_cc_manager" ON public.report_shares
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND public.is_cc_manager_of_project(project_id)
  );

CREATE POLICY "report_shares_update_cc_manager" ON public.report_shares
  FOR UPDATE TO authenticated
  USING (public.is_cc_manager_of_project(project_id));

CREATE POLICY "report_shares_delete_cc_manager" ON public.report_shares
  FOR DELETE TO authenticated
  USING (public.is_cc_manager_of_project(project_id));


-- ── VIEWS — security_invoker zodat ze de RLS van de calling user toepassen
ALTER VIEW public.upload_summary             SET (security_invoker = true);
ALTER VIEW public.appointments_with_feedback SET (security_invoker = true);


-- ── PostgREST schema-cache forceren te herladen ─────────────────────────
NOTIFY pgrst, 'reload schema';


-- ── Cleanup helper-functie ─────────────────────────────────────────────
DROP FUNCTION IF EXISTS public._drop_all_policies(regclass);


-- ════════════════════════════════════════════════════════════════════════
-- KLAAR. Tabel-overzicht van wat nu mogelijk is per rol:
--
-- ROL              SELECT     INSERT/UPDATE eigen     INSERT/UPDATE andere
-- cc_manager       projects   alle uploads/calls op   alle (eigen call_center)
--                  eigen cc   eigen cc projecten
-- cold_caller      projecten  eigen uploads + calls   ✗
--                  waar lid
-- sales_rep        projecten  appointment feedback    ✗
--                  waar lid
-- sales_manager    projecten  appointment feedback    sales_reps aan/uit
--                  waar lid                          project waar zelf op zit
-- ════════════════════════════════════════════════════════════════════════
