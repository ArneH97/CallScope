-- ────────────────────────────────────────────────────────────────────────────
-- project_members.role: 'cold_caller' toelaten
-- Datum:    2026-04-28
-- Reden:    Een cc_manager moet specifieke cold callers per project kunnen
--           toewijzen (i.p.v. impliciet alle members van het gelinkte
--           call_center). Dat doen we door rijen in project_members te zetten
--           met role='cold_caller'.
-- ────────────────────────────────────────────────────────────────────────────

-- Als er een CHECK-constraint is op project_members.role die alleen sales-rollen
-- toelaat: vervang die. (DROP IF EXISTS is veilig.)
DO $$
DECLARE
  c_name text;
BEGIN
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'public.project_members'::regclass
    AND contype  = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%role%'
  LIMIT 1;

  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.project_members DROP CONSTRAINT %I', c_name);
  END IF;
END$$;

-- Nieuwe CHECK met cold_caller erbij
ALTER TABLE public.project_members
  ADD CONSTRAINT project_members_role_check
  CHECK (role IN ('sales_rep', 'sales_manager', 'cold_caller'));

-- Hint: bestaande rijen blijven geldig. Geen data-migratie nodig.
