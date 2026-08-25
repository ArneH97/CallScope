-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: report_shares — gedeelde rapport-links naar klanten
-- Datum:    2026-04-28
-- Reden:    cc_manager kan een rapport delen via een token-link in een e-mail
--           naar de klant. Klant opent /r/[token] zonder in te loggen.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.report_shares (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  created_by  UUID NOT NULL REFERENCES public.profiles(id),
  sent_to     TEXT,                                          -- email klant
  client_name TEXT,
  message     TEXT,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '90 days'),
  viewed_at   TIMESTAMPTZ,                                    -- gevuld bij eerste view
  view_count  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_shares_token      ON public.report_shares (token);
CREATE INDEX IF NOT EXISTS idx_report_shares_project    ON public.report_shares (project_id);
CREATE INDEX IF NOT EXISTS idx_report_shares_created_by ON public.report_shares (created_by);

-- RLS: alleen manager van het call_center mag z'n eigen shares lezen/aanmaken.
ALTER TABLE public.report_shares ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "report_shares: manager beheert" ON public.report_shares;
CREATE POLICY "report_shares: manager beheert" ON public.report_shares
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = report_shares.project_id
        AND cc.manager_id = auth.uid()
    )
  )
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = report_shares.project_id
        AND cc.manager_id = auth.uid()
    )
  );

-- ROLLBACK:
-- DROP TABLE IF EXISTS public.report_shares CASCADE;
