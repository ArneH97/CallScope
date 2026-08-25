-- ────────────────────────────────────────────────────────────────────────────
-- RLS-policies voor call_records
-- Datum: 2026-04-29
-- Reden: Bij upsert (dedup-flow) probeert PostgreSQL existing rijen te UPDATEN.
--        Zonder UPDATE-policy mislukt dat met "new row violates row-level
--        security policy (USING expression) for table 'call_records'".
--        We zetten de volledige CRUD-set voor cc_managers in één keer.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.call_records ENABLE ROW LEVEL SECURITY;

-- SELECT — alle ingelogde users mogen records zien (UI filtert)
DROP POLICY IF EXISTS "call_records_select_authenticated" ON public.call_records;
CREATE POLICY "call_records_select_authenticated" ON public.call_records
  FOR SELECT TO authenticated
  USING (true);

-- INSERT — cc_manager van een gekoppeld call_center mag inserten
DROP POLICY IF EXISTS "call_records_insert_cc_manager" ON public.call_records;
CREATE POLICY "call_records_insert_cc_manager" ON public.call_records
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.uploads u
      JOIN public.call_centers cc ON cc.id = u.call_center_id
      WHERE u.id = call_records.upload_id
        AND cc.manager_id = auth.uid()
    )
  );

-- UPDATE — cc_manager mag updaten (nodig voor upsert dedup)
DROP POLICY IF EXISTS "call_records_update_cc_manager" ON public.call_records;
CREATE POLICY "call_records_update_cc_manager" ON public.call_records
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = call_records.project_id
        AND cc.manager_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = call_records.project_id
        AND cc.manager_id = auth.uid()
    )
  );

-- DELETE — cc_manager mag verwijderen (voor data cleanup)
DROP POLICY IF EXISTS "call_records_delete_cc_manager" ON public.call_records;
CREATE POLICY "call_records_delete_cc_manager" ON public.call_records
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = call_records.project_id
        AND cc.manager_id = auth.uid()
    )
  );

NOTIFY pgrst, 'reload schema';
