-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: Default sales rep per project + RPC voor manuele toewijzing
-- Datum:    2026-04-30
-- Reden:    1) Sync-fallback wanneer de sheet-kolom leeg is of de naam niet
--              matcht: project.default_sales_rep_id wordt gebruikt zodat élke
--              afspraak een rep heeft.
--           2) Cc/sales manager kan vanuit de afspraken-pagina manueel een
--              sales rep aanwijzen op afspraken die nog niet toegewezen zijn
--              (backfill voor bestaande projecten).
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Default rep kolom op projects ──────────────────────────────────────────
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS default_sales_rep_id uuid
    REFERENCES public.profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.projects.default_sales_rep_id IS
  'Fallback sales rep voor afspraken waar de Google Sheet-kolom geen (matchende) naam heeft. Wordt door sync + manuele upload gebruikt zodat elke afspraak altijd een rep heeft.';


-- 2. RPC voor manuele 1-op-1 toewijzing ─────────────────────────────────────
-- Gebruikt vanuit de afspraken-pagina door cc/sales manager. Bypasst RLS
-- (SECURITY DEFINER) maar checkt zelf:
--   - caller is ingelogd
--   - caller is cc_manager / sales_manager (globaal of via project_members)
--   - target sales rep is lid van hetzelfde project (rol sales_rep / sales_manager)
-- Als alles ok is: upsert appointment_feedback met defaults gepland/geen.
CREATE OR REPLACE FUNCTION public.assign_sales_rep_to_call_record(
  p_call_record_id uuid,
  p_sales_rep_id   uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          uuid;
  v_project_id   uuid;
  v_caller_role  text;
  v_caller_pmrole text;
  v_target_role  text;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '28000';
  END IF;

  -- Project achterhalen via call_record
  SELECT cr.project_id INTO v_project_id
  FROM public.call_records cr
  WHERE cr.id = p_call_record_id;

  IF v_project_id IS NULL THEN
    RAISE EXCEPTION 'Call record niet gevonden' USING ERRCODE = '02000';
  END IF;

  -- Caller-rechten: globale rol moet cc_manager of sales_manager zijn,
  -- ÉN (voor sales_manager) moet caller lid zijn van dit project.
  SELECT p.role INTO v_caller_role
  FROM public.profiles p
  WHERE p.id = v_uid;

  SELECT pm.role INTO v_caller_pmrole
  FROM public.project_members pm
  WHERE pm.project_id = v_project_id
    AND pm.profile_id = v_uid
  LIMIT 1;

  IF v_caller_role = 'cc_manager' THEN
    -- cc_manager mag in elk project toewijzen waar hij betrokken is.
    -- (cc_managers zien alle projecten van hun call_center via has_project_access)
    NULL;
  ELSIF v_caller_role = 'sales_manager' AND v_caller_pmrole IS NOT NULL THEN
    -- sales_manager moet lid zijn van het project
    NULL;
  ELSE
    RAISE EXCEPTION 'Geen rechten om sales rep toe te wijzen' USING ERRCODE = '42501';
  END IF;

  -- Target moet sales_rep of sales_manager zijn op dit project
  SELECT pm.role INTO v_target_role
  FROM public.project_members pm
  WHERE pm.project_id = v_project_id
    AND pm.profile_id = p_sales_rep_id
    AND pm.role IN ('sales_rep', 'sales_manager')
  LIMIT 1;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Sales rep is geen lid van dit project' USING ERRCODE = '23503';
  END IF;

  -- Upsert appointment_feedback. Defaults: gepland/geen. Bij conflict
  -- (al feedback) → enkel sales_rep_id overschrijven.
  INSERT INTO public.appointment_feedback
    (call_record_id, sales_rep_id, appointment_status, outcome)
  VALUES
    (p_call_record_id, p_sales_rep_id, 'gepland', 'geen')
  ON CONFLICT (call_record_id) DO UPDATE
    SET sales_rep_id = EXCLUDED.sales_rep_id,
        updated_at   = now();
END $$;

REVOKE ALL ON FUNCTION public.assign_sales_rep_to_call_record(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.assign_sales_rep_to_call_record(uuid, uuid) TO authenticated;


NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS public.assign_sales_rep_to_call_record(uuid, uuid);
-- ALTER TABLE public.projects DROP COLUMN IF EXISTS default_sales_rep_id;
