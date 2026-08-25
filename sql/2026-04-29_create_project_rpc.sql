-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: SECURITY DEFINER functie voor projectaanmaak
-- Datum:    2026-04-29
-- Reden:    Bij directe INSERT op projects + project_call_centers vanuit de
--           UI faalt RLS voor sommige cc_managers (afhankelijk van profile-
--           policy strengheid). Daarnaast gaf de SELECT-na-INSERT (.select()
--           .single()) extra problemen omdat de gebruiker op dát moment nog
--           geen toegangspad heeft tot het net-aangemaakte project — de
--           pcc-link bestaat dan nog niet.
--
--           Oplossing: één atomaire functie die als function-owner draait
--           (SECURITY DEFINER), de gebruiker handmatig autoriseert via
--           auth.uid() + profiles.role check, en de project + pcc-link in
--           één transactie aanmaakt.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_project(
  p_name text,
  p_description text DEFAULT NULL
)
RETURNS public.projects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id        uuid;
  v_call_center_id uuid;
  v_project        public.projects;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Authorisatie: alleen cc_managers mogen projecten aanmaken
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_user_id AND role = 'cc_manager'
  ) THEN
    RAISE EXCEPTION 'Only call center managers can create projects';
  END IF;

  -- Vind het call_center van de gebruiker
  SELECT id INTO v_call_center_id
  FROM public.call_centers
  WHERE manager_id = v_user_id
  LIMIT 1;

  IF v_call_center_id IS NULL THEN
    RAISE EXCEPTION 'No call center found — create one first';
  END IF;

  -- Atomaire insert van project + pcc-link
  INSERT INTO public.projects (name, description)
  VALUES (p_name, p_description)
  RETURNING * INTO v_project;

  INSERT INTO public.project_call_centers (project_id, call_center_id)
  VALUES (v_project.id, v_call_center_id);

  RETURN v_project;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_project(text, text) TO authenticated;
NOTIFY pgrst, 'reload schema';
