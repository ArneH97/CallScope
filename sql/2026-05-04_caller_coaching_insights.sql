-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: AI-coaching adviezen per cold caller
-- Datum:    2026-05-04
-- Reden:    Cold callers krijgen op hun dashboard een gepersonaliseerd advies
--           op basis van hun eigen calls van de laatste 30 dagen — top
--           bezwaren, reach rate, conversie, sample notes. We cachen de
--           gegenereerde adviezen (één per caller) zodat we niet bij elke
--           dashboard-bezoek opnieuw GPT-4o-mini moeten aanroepen.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.caller_coaching_insights (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  advice_text     text NOT NULL,
  context_summary jsonb,                                                 -- input-aggregaten voor debugging + display ("gebaseerd op N calls")
  generated_at    timestamptz NOT NULL DEFAULT now(),
  -- Eén actief advies per caller. Bij regenerate doen we UPSERT.
  UNIQUE (caller_id)
);

CREATE INDEX IF NOT EXISTS idx_cci_caller ON public.caller_coaching_insights (caller_id);

ALTER TABLE public.caller_coaching_insights ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.caller_coaching_insights');

-- Caller mag eigen advies lezen
CREATE POLICY "cci_caller_select_own" ON public.caller_coaching_insights
  FOR SELECT TO authenticated
  USING (caller_id = auth.uid());

-- Cc_manager mag advies van zijn callers lezen — via call_center_members
CREATE POLICY "cci_cc_manager_select" ON public.caller_coaching_insights
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.call_centers cc
      JOIN public.call_center_members ccm ON ccm.call_center_id = cc.id
      WHERE cc.manager_id = auth.uid()
        AND ccm.profile_id = caller_coaching_insights.caller_id
    )
  );

-- Schrijven gebeurt server-side via service_role, dus geen INSERT/UPDATE-policies.

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS public.idx_cci_caller;
-- DROP TABLE IF EXISTS public.caller_coaching_insights;
