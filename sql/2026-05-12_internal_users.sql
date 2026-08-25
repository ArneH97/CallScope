-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: is_internal flag op profiles + bypass van billing-restricties
-- Datum:    2026-05-12
-- Reden:    De CallScope-owner (Arne) en eventuele toekomstige interne
--           medewerkers / investeerder-demo-accounts moeten onbeperkt
--           projecten kunnen aanmaken en behouden zonder Stripe-betaling.
--
--           Implementatie: `profiles.is_internal` boolean. Wanneer true:
--             - create_project RPC slaat de trial/subscription-check over
--             - Nieuwe projecten van interne users krijgen direct status
--               'active' (geen trial-teller, geen verloopdatum)
--             - Bestaande projecten van interne users worden opgewerkt
--               naar 'active' zodat hun sync-gate niet meer blokkeert
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Kolom toevoegen
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;

-- 2. Arne markeren als internal user
UPDATE public.profiles
SET is_internal = true
WHERE email = 'arne@halcoservices.be';

-- 3. Bestaande projecten van interne users: zet op 'active', wis trial-datum
--    Zo verdwijnen de trial-banners en stopt de blocking bij sync of bij
--    create_project voor 2de+ project.
UPDATE public.projects p
SET subscription_status = 'active',
    trial_ends_at       = NULL
FROM public.project_call_centers pcc
JOIN public.call_centers cc ON cc.id = pcc.call_center_id
JOIN public.profiles    pr ON pr.id = cc.manager_id
WHERE p.id = pcc.project_id
  AND pr.is_internal = true
  AND p.subscription_status <> 'active';

-- 4. create_project RPC: voor internal users meteen status='active', geen
--    "bestaand project zonder abonnement"-check.
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
  v_is_internal       boolean;
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

  -- Auth: alleen cc_managers + meteen is_internal-flag ophalen
  SELECT is_internal INTO v_is_internal
  FROM public.profiles
  WHERE id = v_user_id AND role = 'cc_manager';

  IF v_is_internal IS NULL THEN
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

  -- Internal users: skip alle billing-gates, project meteen actief
  IF v_is_internal THEN
    v_initial_status    := 'active';
    v_initial_trial_end := NULL;
  ELSE
    -- Reguliere logica: 1 trial per cc_manager
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

    -- 1ste project = trial, 2de+ = past_due (vereist directe checkout)
    IF v_existing_count = 0 THEN
      v_initial_status    := 'trialing';
      v_initial_trial_end := now() + interval '30 days';
    ELSE
      v_initial_status    := 'past_due';
      v_initial_trial_end := NULL;
    END IF;
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

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS is_internal;
-- (en restore vorige versie van create_project via 2026-04-30_create_project_one_trial_rule.sql)
