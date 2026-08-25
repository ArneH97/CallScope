-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: per-caller uurtarieven + wekelijkse uren-bevestigingen
-- Datum:    2026-05-04
-- Reden:    Cc_managers willen per project per cold caller instellen:
--             - hoeveel uren hij wekelijks zou moeten werken (preset)
--             - wat het uurtarief is voor de eindklant
--           Vrijdag 17:00 UTC krijgt de cc_manager een mail om de
--           gepresteerde uren van die week te bevestigen (preset is default,
--           kan aangepast worden).
--
--           Beide tabellen zijn OPTIONEEL — als de cc_manager geen tarief/
--           preset invult, blijft de feature volledig verborgen op het
--           dashboard. Geen kost = geen kost-metrics.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Per-(project, caller) tarief + preset ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.project_caller_rates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  caller_id           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  weekly_hours_preset numeric CHECK (weekly_hours_preset IS NULL OR weekly_hours_preset >= 0),
  hourly_rate         numeric CHECK (hourly_rate IS NULL OR hourly_rate >= 0),
  currency            text NOT NULL DEFAULT 'EUR',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, caller_id)
);

ALTER TABLE public.project_caller_rates ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.project_caller_rates');

-- cc_manager van project: full access (kan tarieven instellen)
CREATE POLICY "pcr_cc_manager_all" ON public.project_caller_rates
  FOR ALL TO authenticated
  USING (public.is_cc_manager_of_project(project_id))
  WITH CHECK (public.is_cc_manager_of_project(project_id));

-- sales_manager van project: SELECT (voor metrics op dashboard/rapport)
CREATE POLICY "pcr_sales_manager_select" ON public.project_caller_rates
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = project_caller_rates.project_id
        AND pm.profile_id = auth.uid()
        AND pm.role = 'sales_manager'
    )
  );

-- cold caller: SELECT eigen rij (zo ziet hij wat hij zou verdienen — transparant)
CREATE POLICY "pcr_caller_select_own" ON public.project_caller_rates
  FOR SELECT TO authenticated
  USING (caller_id = auth.uid());


-- 2. Wekelijkse uren-bevestigingen ─────────────────────────────────────────
-- Eén rij per (project, caller, week_start). Bij her-bevestigen wordt de
-- bestaande rij geüpdatet (UPSERT-target via UNIQUE).
--
-- week_start_date = de maandag van de bevestigde week (ISO standaard).
CREATE TABLE IF NOT EXISTS public.weekly_hour_confirmations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  caller_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  week_start_date date NOT NULL,
  hours_actual    numeric NOT NULL CHECK (hours_actual >= 0 AND hours_actual <= 168),
  confirmed_at    timestamptz NOT NULL DEFAULT now(),
  confirmed_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (project_id, caller_id, week_start_date)
);

CREATE INDEX IF NOT EXISTS idx_whc_project_week
  ON public.weekly_hour_confirmations (project_id, week_start_date);

ALTER TABLE public.weekly_hour_confirmations ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.weekly_hour_confirmations');

-- cc_manager van project: full access
CREATE POLICY "whc_cc_manager_all" ON public.weekly_hour_confirmations
  FOR ALL TO authenticated
  USING (public.is_cc_manager_of_project(project_id))
  WITH CHECK (public.is_cc_manager_of_project(project_id));

-- sales_manager: SELECT voor metrics
CREATE POLICY "whc_sales_manager_select" ON public.weekly_hour_confirmations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = weekly_hour_confirmations.project_id
        AND pm.profile_id = auth.uid()
        AND pm.role = 'sales_manager'
    )
  );

-- cold caller: SELECT eigen rijen (zo kan hij zijn eigen geboekte uren zien)
CREATE POLICY "whc_caller_select_own" ON public.weekly_hour_confirmations
  FOR SELECT TO authenticated
  USING (caller_id = auth.uid());


-- 3. Trigger om updated_at te bumpen ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public._bump_pcr_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pcr_bump_updated_at ON public.project_caller_rates;
CREATE TRIGGER trg_pcr_bump_updated_at
  BEFORE UPDATE ON public.project_caller_rates
  FOR EACH ROW EXECUTE FUNCTION public._bump_pcr_updated_at();


NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- DROP TRIGGER IF EXISTS trg_pcr_bump_updated_at ON public.project_caller_rates;
-- DROP FUNCTION IF EXISTS public._bump_pcr_updated_at();
-- DROP TABLE IF EXISTS public.weekly_hour_confirmations;
-- DROP TABLE IF EXISTS public.project_caller_rates;
