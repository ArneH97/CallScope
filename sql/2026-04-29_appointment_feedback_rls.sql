-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: appointment_feedback — UNIQUE constraint + RLS
-- Datum:    2026-04-29
-- Reden:    Sales reps geven feedback op afspraken, sales managers moeten
--           ook bestaande feedback kunnen herzien wanneer een afspraak van
--           status verandert. We zetten:
--             - UNIQUE (call_record_id): 1 feedback-rij per afspraak (nodig
--               voor upsert ON CONFLICT in de UI)
--             - SELECT-policy: alle ingelogden mogen feedback zien
--             - INSERT-policy: alleen sales_rep/sales_manager mogen feedback
--               aanmaken, en alleen als sales_rep_id == auth.uid()
--             - UPDATE-policy: sales_rep én sales_manager mogen wijzigen,
--               zodat de manager altijd een bestaande feedback kan corrigeren
-- ────────────────────────────────────────────────────────────────────────────

-- 1. UNIQUE constraint --------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.appointment_feedback'::regclass
      AND contype  = 'u'
      AND conname  = 'appointment_feedback_call_record_unique'
  ) THEN
    -- Eerst eventuele duplicaten opruimen (laatst geüpdatete rij behouden)
    DELETE FROM public.appointment_feedback a
    USING public.appointment_feedback b
    WHERE a.call_record_id = b.call_record_id
      AND a.id < b.id;

    ALTER TABLE public.appointment_feedback
      ADD CONSTRAINT appointment_feedback_call_record_unique
      UNIQUE (call_record_id);
  END IF;
END $$;


-- 2. RLS policies -------------------------------------------------------------
ALTER TABLE public.appointment_feedback ENABLE ROW LEVEL SECURITY;

-- SELECT — alle ingelogden mogen lezen (UI filtert)
DROP POLICY IF EXISTS "appt_fb_select_authenticated" ON public.appointment_feedback;
CREATE POLICY "appt_fb_select_authenticated" ON public.appointment_feedback
  FOR SELECT TO authenticated
  USING (true);

-- INSERT — alleen sales_rep/sales_manager mogen feedback indienen.
-- sales_rep_id moet == auth.uid() zijn (voorkomt feedback in andermans naam).
DROP POLICY IF EXISTS "appt_fb_insert_sales" ON public.appointment_feedback;
CREATE POLICY "appt_fb_insert_sales" ON public.appointment_feedback
  FOR INSERT TO authenticated
  WITH CHECK (
    sales_rep_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id   = auth.uid()
        AND p.role IN ('sales_rep', 'sales_manager')
    )
  );

-- UPDATE — sales_rep én sales_manager mogen wijzigen.
-- De manager moet altijd kunnen corrigeren ook al heeft een andere rep
-- de oorspronkelijke feedback gegeven.
DROP POLICY IF EXISTS "appt_fb_update_sales" ON public.appointment_feedback;
CREATE POLICY "appt_fb_update_sales" ON public.appointment_feedback
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id   = auth.uid()
        AND p.role IN ('sales_rep', 'sales_manager')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id   = auth.uid()
        AND p.role IN ('sales_rep', 'sales_manager')
    )
  );

-- DELETE — alleen sales_manager (clean-up van foutieve feedback)
DROP POLICY IF EXISTS "appt_fb_delete_manager" ON public.appointment_feedback;
CREATE POLICY "appt_fb_delete_manager" ON public.appointment_feedback
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id   = auth.uid()
        AND p.role = 'sales_manager'
    )
  );

NOTIFY pgrst, 'reload schema';
