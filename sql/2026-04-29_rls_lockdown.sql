-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: RLS-lockdown — gebruikers zien alleen data van projecten waar
--           ze toegang toe hebben. Tot nu toe was alle SELECT 'USING (true)'
--           wat ervoor zorgde dat een net-aangemaakte sales_manager zonder
--           project-toegang toch alle data van alle projecten kon zien.
-- Datum:    2026-04-29
--
-- Twee toegangspaden naar een project:
--   A) Via call_center: gebruiker is manager van een call_center dat aan
--      het project gekoppeld is (project_call_centers).
--   B) Via expliciete project-membership (project_members): voor sales_rep,
--      sales_manager, en cold_caller.
--
-- Tabellen waar we SELECT-policy verstrengen:
--   • projects, uploads, call_records, appointment_feedback, analyses
--   • project_members, project_call_centers
--
-- Views (upload_summary, appointments_with_feedback) krijgen security_invoker
-- aan, zodat ze de RLS van de onderliggende tabellen toepassen ipv te
-- runnen als view-owner (die alles ziet).
-- ────────────────────────────────────────────────────────────────────────────

-- 1. PROJECTS ────────────────────────────────────────────────────────────────
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "projects_select_authenticated"      ON public.projects;
DROP POLICY IF EXISTS "projects_select_member_or_manager"  ON public.projects;
CREATE POLICY "projects_select_member_or_manager" ON public.projects
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = projects.id
        AND cc.manager_id  = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = projects.id
        AND pm.profile_id = auth.uid()
    )
  );


-- 2. UPLOADS ─────────────────────────────────────────────────────────────────
ALTER TABLE public.uploads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "uploads_select_authenticated"      ON public.uploads;
DROP POLICY IF EXISTS "uploads_select_member_or_manager"  ON public.uploads;
CREATE POLICY "uploads_select_member_or_manager" ON public.uploads
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = uploads.project_id
        AND cc.manager_id  = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = uploads.project_id
        AND pm.profile_id = auth.uid()
    )
  );


-- 3. CALL_RECORDS ────────────────────────────────────────────────────────────
ALTER TABLE public.call_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "call_records_select_authenticated"     ON public.call_records;
DROP POLICY IF EXISTS "call_records_select_member_or_manager" ON public.call_records;
CREATE POLICY "call_records_select_member_or_manager" ON public.call_records
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = call_records.project_id
        AND cc.manager_id  = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = call_records.project_id
        AND pm.profile_id = auth.uid()
    )
  );


-- 4. APPOINTMENT_FEEDBACK (via call_records → project_id) ────────────────────
ALTER TABLE public.appointment_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "appt_fb_select_authenticated"     ON public.appointment_feedback;
DROP POLICY IF EXISTS "appt_fb_select_member_or_manager" ON public.appointment_feedback;
CREATE POLICY "appt_fb_select_member_or_manager" ON public.appointment_feedback
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.call_records cr
      WHERE cr.id = appointment_feedback.call_record_id
        AND (
          EXISTS (
            SELECT 1 FROM public.project_call_centers pcc
            JOIN public.call_centers cc ON cc.id = pcc.call_center_id
            WHERE pcc.project_id = cr.project_id
              AND cc.manager_id  = auth.uid()
          )
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = cr.project_id
              AND pm.profile_id = auth.uid()
          )
        )
    )
  );


-- 5. ANALYSES (via uploads → project_id) ────────────────────────────────────
ALTER TABLE public.analyses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "analyses_select_authenticated"     ON public.analyses;
DROP POLICY IF EXISTS "analyses_select_member_or_manager" ON public.analyses;
CREATE POLICY "analyses_select_member_or_manager" ON public.analyses
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.uploads u
      WHERE u.id = analyses.upload_id
        AND (
          EXISTS (
            SELECT 1 FROM public.project_call_centers pcc
            JOIN public.call_centers cc ON cc.id = pcc.call_center_id
            WHERE pcc.project_id = u.project_id
              AND cc.manager_id  = auth.uid()
          )
          OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = u.project_id
              AND pm.profile_id = auth.uid()
          )
        )
    )
  );


-- 6. PROJECT_MEMBERS (zie wie op de projecten zit waar ik bij hoor) ─────────
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pm_select_authenticated"  ON public.project_members;
DROP POLICY IF EXISTS "pm_select_same_project"   ON public.project_members;
CREATE POLICY "pm_select_same_project" ON public.project_members
  FOR SELECT TO authenticated
  USING (
    profile_id = auth.uid()
    OR project_id IN (
      SELECT pm2.project_id FROM public.project_members pm2
      WHERE pm2.profile_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = project_members.project_id
        AND cc.manager_id  = auth.uid()
    )
  );


-- 7. PROJECT_CALL_CENTERS ───────────────────────────────────────────────────
ALTER TABLE public.project_call_centers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pcc_select_authenticated"     ON public.project_call_centers;
DROP POLICY IF EXISTS "pcc_select_member_or_manager" ON public.project_call_centers;
CREATE POLICY "pcc_select_member_or_manager" ON public.project_call_centers
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.call_centers cc
      WHERE cc.id = project_call_centers.call_center_id
        AND cc.manager_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = project_call_centers.project_id
        AND pm.profile_id = auth.uid()
    )
  );


-- 8. VIEWS — security_invoker zodat ze de RLS van de calling user toepassen
--    i.p.v. die van de view-owner (die alles mag).
--    Vereist PostgreSQL 15+. Supabase-projecten draaien daar standaard op.
ALTER VIEW public.upload_summary              SET (security_invoker = true);
ALTER VIEW public.appointments_with_feedback  SET (security_invoker = true);


-- 9. PostgREST schema-cache forceren te herladen ─────────────────────────────
NOTIFY pgrst, 'reload schema';
