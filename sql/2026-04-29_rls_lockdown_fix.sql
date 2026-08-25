-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: RLS-lockdown — bugfix met SECURITY DEFINER helper
-- Datum:    2026-04-29
-- Reden:    De vorige RLS-lockdown bracht een circulaire RLS-evaluatie:
--           projects.SELECT keek in project_call_centers (met RLS), dat keek
--           in project_members (met RLS), dat zelf weer naar pcc/projects
--           verwees. PostgreSQL kon de chain niet correct evalueren waardoor
--           ook cc_managers hun eigen projecten niet meer zagen.
--
--           Fix: één helper-functie public.has_project_access(uuid) die
--           SECURITY DEFINER draait. Daarmee runt de inner-check als
--           function-owner (zonder RLS), maar auth.uid() blijft de
--           calling user. Geen recursie meer, eenduidige logica.
-- ────────────────────────────────────────────────────────────────────────────

-- Helper-functie ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.has_project_access(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
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


-- Policies herschrijven om de helper te gebruiken ──────────────────────────

-- projects
DROP POLICY IF EXISTS "projects_select_member_or_manager" ON public.projects;
CREATE POLICY "projects_select_member_or_manager" ON public.projects
  FOR SELECT TO authenticated
  USING (public.has_project_access(projects.id));

-- uploads
DROP POLICY IF EXISTS "uploads_select_member_or_manager" ON public.uploads;
CREATE POLICY "uploads_select_member_or_manager" ON public.uploads
  FOR SELECT TO authenticated
  USING (public.has_project_access(uploads.project_id));

-- call_records
DROP POLICY IF EXISTS "call_records_select_member_or_manager" ON public.call_records;
CREATE POLICY "call_records_select_member_or_manager" ON public.call_records
  FOR SELECT TO authenticated
  USING (public.has_project_access(call_records.project_id));

-- appointment_feedback (via call_records → project_id)
DROP POLICY IF EXISTS "appt_fb_select_member_or_manager" ON public.appointment_feedback;
CREATE POLICY "appt_fb_select_member_or_manager" ON public.appointment_feedback
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.call_records cr
      WHERE cr.id = appointment_feedback.call_record_id
        AND public.has_project_access(cr.project_id)
    )
  );

-- analyses (via uploads → project_id)
DROP POLICY IF EXISTS "analyses_select_member_or_manager" ON public.analyses;
CREATE POLICY "analyses_select_member_or_manager" ON public.analyses
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.uploads u
      WHERE u.id = analyses.upload_id
        AND public.has_project_access(u.project_id)
    )
  );

-- project_members (zien wie op je projecten zit)
DROP POLICY IF EXISTS "pm_select_same_project" ON public.project_members;
CREATE POLICY "pm_select_same_project" ON public.project_members
  FOR SELECT TO authenticated
  USING (
    profile_id = auth.uid()
    OR public.has_project_access(project_members.project_id)
  );

-- project_call_centers
DROP POLICY IF EXISTS "pcc_select_member_or_manager" ON public.project_call_centers;
CREATE POLICY "pcc_select_member_or_manager" ON public.project_call_centers
  FOR SELECT TO authenticated
  USING (public.has_project_access(project_call_centers.project_id));

NOTIFY pgrst, 'reload schema';
