-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: Trial-duur van 30 dagen naar 14 dagen
-- Datum:    2026-04-30
-- Reden:    Pricing-update — €49/maand per project, met 14 dagen gratis trial
--           (was 30). Korte trial filtert voor serieuzere intent.
--
--           Bestaande trialing projecten worden NIET verkort. Enkel nieuwe
--           projecten krijgen 14 dagen vanaf creation.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. create_project RPC: trial duur 30d → 14d ─────────────────────────────
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

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_user_id AND role = 'cc_manager'
  ) THEN
    RAISE EXCEPTION 'Alleen call center managers kunnen projecten aanmaken'
      USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_call_center_id
  FROM public.call_centers
  WHERE manager_id = v_user_id
  LIMIT 1;

  IF v_call_center_id IS NULL THEN
    RAISE EXCEPTION 'Geen call center gevonden — maak eerst een call center aan'
      USING ERRCODE = '02000';
  END IF;

  SELECT COUNT(*) INTO v_existing_count
  FROM public.project_call_centers pcc
  WHERE pcc.call_center_id = v_call_center_id;

  SELECT COUNT(*) INTO v_active_count
  FROM public.project_call_centers pcc
  JOIN public.projects p ON p.id = pcc.project_id
  WHERE pcc.call_center_id = v_call_center_id
    AND p.subscription_status = 'active';

  IF v_existing_count > 0 AND v_active_count = 0 THEN
    RAISE EXCEPTION 'Activeer eerst een abonnement op je bestaande project voor je een nieuw kan aanmaken'
      USING ERRCODE = '42501';
  END IF;

  -- 1ste project = 14 dagen trial. 2de+ = past_due (vereist directe checkout).
  IF v_existing_count = 0 THEN
    v_initial_status    := 'trialing';
    v_initial_trial_end := now() + interval '14 days';
  ELSE
    v_initial_status    := 'past_due';
    v_initial_trial_end := NULL;
  END IF;

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


-- 2. Trigger _set_project_trial_defaults: ook 30d → 14d voor direct INSERTs ─
CREATE OR REPLACE FUNCTION public._set_project_trial_defaults()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.trial_ends_at IS NULL THEN
    NEW.trial_ends_at := now() + interval '14 days';
  END IF;
  IF NEW.subscription_status IS NULL THEN
    NEW.subscription_status := 'trialing';
  END IF;
  RETURN NEW;
END $$;


NOTIFY pgrst, 'reload schema';
