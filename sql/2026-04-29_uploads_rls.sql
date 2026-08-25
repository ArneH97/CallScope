-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: RLS-policies voor uploads (INSERT/UPDATE/DELETE)
-- Datum:    2026-04-29
-- Reden:    De RLS-lockdown migratie zette een SELECT-policy op uploads, maar
--           er was geen expliciete INSERT/UPDATE/DELETE-policy. Met RLS aan +
--           geen INSERT-policy = alle inserts geblokkeerd, ook voor de
--           cc_manager die nochtans toegang tot het project heeft.
--
--           We zetten:
--             - INSERT: cc_manager OF cold_caller-lid van het call_center
--             - UPDATE: idem (callers moeten status kunnen updaten naar 'done')
--             - DELETE: alleen cc_manager
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.uploads ENABLE ROW LEVEL SECURITY;

-- INSERT
DROP POLICY IF EXISTS "uploads_insert_cc_member" ON public.uploads;
CREATE POLICY "uploads_insert_cc_member" ON public.uploads
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.call_centers cc
      WHERE cc.id = uploads.call_center_id
        AND cc.manager_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.call_center_members ccm
      WHERE ccm.call_center_id = uploads.call_center_id
        AND ccm.profile_id = auth.uid()
    )
  );

-- UPDATE — status (pending → done → error)
DROP POLICY IF EXISTS "uploads_update_cc_manager" ON public.uploads;
CREATE POLICY "uploads_update_cc_manager" ON public.uploads
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.call_centers cc
      WHERE cc.id = uploads.call_center_id
        AND cc.manager_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.call_center_members ccm
      WHERE ccm.call_center_id = uploads.call_center_id
        AND ccm.profile_id = auth.uid()
    )
  );

-- DELETE — alleen cc_manager (cleanup)
DROP POLICY IF EXISTS "uploads_delete_cc_manager" ON public.uploads;
CREATE POLICY "uploads_delete_cc_manager" ON public.uploads
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.call_centers cc
      WHERE cc.id = uploads.call_center_id
        AND cc.manager_id = auth.uid()
    )
  );

NOTIFY pgrst, 'reload schema';
