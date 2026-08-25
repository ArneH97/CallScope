-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: delete_project RPC (SECURITY DEFINER)
-- Datum:    2026-04-30
-- Reden:    Cc-managers moeten projecten kunnen verwijderen, maar RLS
--           verhindert dat ze rechtstreeks alle subtabellen kunnen wissen.
--           Deze functie:
--             1. Authenticeert de caller en checkt dat hij cc_manager is van
--                het call_center waaraan dit project gekoppeld is.
--             2. Cascade-verwijdert in de juiste volgorde alle bijhorende
--                data (analyses, call_records, appointment_feedback, uploads,
--                project_members, sheet-bindings, report_shares, project).
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.delete_project(p_project_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id        uuid;
  v_call_center_id uuid;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- Authorisatie: alleen cc_managers
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_user_id AND role = 'cc_manager'
  ) THEN
    RAISE EXCEPTION 'Alleen call center managers kunnen projecten verwijderen' USING ERRCODE = '42501';
  END IF;

  -- Project moet onder het call_center van de manager vallen.
  SELECT cc.id INTO v_call_center_id
  FROM public.call_centers cc
  JOIN public.project_call_centers pcc ON pcc.call_center_id = cc.id
  WHERE cc.manager_id = v_user_id
    AND pcc.project_id = p_project_id
  LIMIT 1;

  IF v_call_center_id IS NULL THEN
    RAISE EXCEPTION 'Project niet gevonden of geen toegang' USING ERRCODE = '42501';
  END IF;

  -- Cascade verwijderen in juiste volgorde — child eerst, parent laatst.
  -- Veel FKs hebben al ON DELETE CASCADE maar we zijn expliciet voor zekerheid
  -- in alle environments (sommige policies/triggers kunnen impliciete cascade
  -- blokkeren, dus liever expliciet vanuit deze SECURITY DEFINER context).

  DELETE FROM public.appointment_feedback
    WHERE call_record_id IN (
      SELECT id FROM public.call_records WHERE project_id = p_project_id
    );

  DELETE FROM public.analyses
    WHERE upload_id IN (
      SELECT id FROM public.uploads WHERE project_id = p_project_id
    );

  DELETE FROM public.call_records       WHERE project_id = p_project_id;
  DELETE FROM public.uploads            WHERE project_id = p_project_id;
  DELETE FROM public.project_google_sheets WHERE project_id = p_project_id;
  DELETE FROM public.project_members    WHERE project_id = p_project_id;
  DELETE FROM public.project_call_centers WHERE project_id = p_project_id;
  DELETE FROM public.report_shares      WHERE project_id = p_project_id;
  DELETE FROM public.projects           WHERE id         = p_project_id;
END $$;

REVOKE ALL ON FUNCTION public.delete_project(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.delete_project(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
