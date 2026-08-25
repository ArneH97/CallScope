-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: project_members — sales_manager mag sales_rep beheren
-- Datum:    2026-04-29
-- Reden:    Tot nu toe konden alleen cc_managers leden toevoegen aan
--           projecten. Sales managers moeten ook hun eigen sales_reps kunnen
--           toevoegen/verwijderen, op projecten waar zijzelf lid van zijn.
--
--           Permissies:
--             - cc_manager: alle rollen toevoegen/verwijderen (bestaande policy)
--             - sales_manager: alleen role='sales_rep' toevoegen/verwijderen,
--               en alleen op projecten waar zijzelf in staan
-- ────────────────────────────────────────────────────────────────────────────

-- INSERT — sales_manager mag sales_rep toevoegen
DROP POLICY IF EXISTS "pm_insert_sales_manager" ON public.project_members;
CREATE POLICY "pm_insert_sales_manager" ON public.project_members
  FOR INSERT TO authenticated
  WITH CHECK (
    project_members.role = 'sales_rep'
    AND EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = project_members.project_id
        AND pm.profile_id = auth.uid()
        AND pm.role = 'sales_manager'
    )
  );

-- DELETE — sales_manager mag sales_rep verwijderen
DROP POLICY IF EXISTS "pm_delete_sales_manager" ON public.project_members;
CREATE POLICY "pm_delete_sales_manager" ON public.project_members
  FOR DELETE TO authenticated
  USING (
    project_members.role = 'sales_rep'
    AND EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = project_members.project_id
        AND pm.profile_id = auth.uid()
        AND pm.role = 'sales_manager'
    )
  );

-- (Optioneel) UPDATE-policy als we ooit de role van een member willen kunnen
-- wijzigen vanuit de UI. Niet nodig voor huidige feature; overslaan.

NOTIFY pgrst, 'reload schema';
