-- ────────────────────────────────────────────────────────────────────────────
-- Rapport-annotaties (persistente commentaar/duiding per sectie) +
-- simulator-aannames per project.
--
-- Doel:
--  1. cc_manager kan bij elke sectie van het rapport een notitie toevoegen
--     (introductie, interpretatie, context) die bewaard blijft en verschijnt
--     in de PDF. Notities zijn geïndexeerd per (project, periode, sectie)
--     zodat een rapport van "juli 2026" andere annotaties heeft dan "aug".
--  2. Simulator toont het potentieel van een samenwerking (deals, ARR, ROI)
--     op basis van 3 aannames: no-show %, closing %, ARR per deal.
--     Aannames zijn per project instelbaar en worden bewaard tussen sessies.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Annotations
CREATE TABLE IF NOT EXISTS public.report_annotations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  -- period_key: string identifier voor de rapport-periode.
  -- Formaat: "month:2026-07" | "week:2026-07-06" | "custom:2026-07-01_2026-07-31"
  -- Zo kan één project meerdere rapporten hebben (juli, aug, custom-range) met elk eigen notities.
  period_key  TEXT NOT NULL,
  -- section_key: welke sectie in het rapport.
  -- Bv "overview" | "funnel" | "dealstages" | "objections" | "per_caller_intro"
  --    | "caller:<uuid>" | "simulator" | "wrapup"
  section_key TEXT NOT NULL,
  text        TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  UNIQUE (project_id, period_key, section_key)
);

CREATE INDEX IF NOT EXISTS report_annotations_lookup_idx
  ON public.report_annotations (project_id, period_key);

-- RLS: alleen cc_manager van het bijhorende call_center mag lezen/schrijven.
ALTER TABLE public.report_annotations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "report_annotations_read" ON public.report_annotations;
CREATE POLICY "report_annotations_read"
  ON public.report_annotations
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = report_annotations.project_id
        AND cc.manager_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "report_annotations_write" ON public.report_annotations;
CREATE POLICY "report_annotations_write"
  ON public.report_annotations
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = report_annotations.project_id
        AND cc.manager_id = auth.uid()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.report_annotations TO authenticated;

-- 2. Simulator-aannames op projects
-- Defaults kloppen met de Restomanager-cijfers (Jef): no_show 10%, closing 38%,
-- ARR €1200/deal. Andere klanten kunnen andere waarden invullen.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS sim_no_show_rate   NUMERIC(5,2) NOT NULL DEFAULT 10.00,
  ADD COLUMN IF NOT EXISTS sim_closing_rate   NUMERIC(5,2) NOT NULL DEFAULT 38.00,
  ADD COLUMN IF NOT EXISTS sim_arr_per_deal   NUMERIC(10,2) NOT NULL DEFAULT 1200.00,
  ADD COLUMN IF NOT EXISTS sim_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS sim_updated_at     TIMESTAMPTZ;
