-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: create_project — 1 trial per cc_manager, 2de+ project moet betaald
-- Datum:    2026-04-30
-- Reden:    Pricing logica: een call center krijgt EÉN gratis trial-project
--           van 30 dagen. Daarna kan er enkel een 2de+ project aangemaakt
--           worden als er minstens één actief abonnement loopt — en het 2de+
--           project zelf vereist directe Stripe-checkout (geen extra trial).
--
--           Voorkomt dat cc-managers eindeloos nieuwe trial-projecten maken
--           om gratis te blijven gebruiken.
-- ────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.create_project(text, text, text, text, uuid);

CREATE OR REPLACE FUNCTION public.create_project(
  p_name                 text,
  p_description          text   DEFAULT NULL,
  p_upload_source        text   DEFAULT 'manual',
  p_feedback_source      text   DEFAULT 'manual',
  p_default_sales_rep_id uuid   DEFAULT NULL
)
RETURNS public.projects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id           uuid;
  v_call_center_id    uuid;
  v_existing_count    int;
  v_active_count      int;
  v_initial_status    text;
  v_initial_trial_end timestamptz;
  v_project           public.projects;
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
    RAISE EXCEPTION 'Alleen call center managers kunnen projecten aanmaken'
      USING ERRCODE = '42501';
  END IF;

  -- Vind call_center
  SELECT id INTO v_call_center_id
  FROM public.call_centers
  WHERE manager_id = v_user_id
  LIMIT 1;

  IF v_call_center_id IS NULL THEN
    RAISE EXCEPTION 'Geen call center gevonden — maak eerst een call center aan'
      USING ERRCODE = '02000';
  END IF;

  -- Tel bestaande projecten van deze cc_manager + actieve abonnementen
  SELECT COUNT(*) INTO v_existing_count
  FROM public.project_call_centers pcc
  WHERE pcc.call_center_id = v_call_center_id;

  SELECT COUNT(*) INTO v_active_count
  FROM public.project_call_centers pcc
  JOIN public.projects p ON p.id = pcc.project_id
  WHERE pcc.call_center_id = v_call_center_id
    AND p.subscription_status = 'active';

  -- Block: bestaand project zonder actief abonnement → activeer eerst
  IF v_existing_count > 0 AND v_active_count = 0 THEN
    RAISE EXCEPTION 'Activeer eerst een abonnement op je bestaande project voor je een nieuw kan aanmaken'
      USING ERRCODE = '42501';
  END IF;

  -- 1ste project = trial. 2de+ = past_due (vereist directe checkout).
  IF v_existing_count = 0 THEN
    v_initial_status    := 'trialing';
    v_initial_trial_end := now() + interval '30 days';
  ELSE
    v_initial_status    := 'past_due';
    v_initial_trial_end := NULL;
  END IF;

  -- Atomaire insert van project + pcc-link
  INSERT INTO public.projects (
    name, description, upload_source, feedback_source, default_sales_rep_id,
    subscription_status, trial_ends_at
  )
  VALUES (
    p_name,
    p_description,
    COALESCE(p_upload_source,   'manual'),
    COALESCE(p_feedback_source, 'manual'),
    p_default_sales_rep_id,
    v_initial_status,
    v_initial_trial_end
  )
  RETURNING * INTO v_project;

  INSERT INTO public.project_call_centers (project_id, call_center_id)
  VALUES (v_project.id, v_call_center_id);

  RETURN v_project;
END $$;

REVOKE ALL ON FUNCTION public.create_project(text, text, text, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.create_project(text, text, text, text, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
