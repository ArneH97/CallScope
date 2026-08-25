-- ────────────────────────────────────────────────────────────────────────────
-- Manueel de afspraakdatum instellen / wijzigen / wissen.
--
-- Achtergrond: `appointment_feedback.appointment_date` bestaat al maar was
-- tot nu toe alleen te zetten via het volledige feedback-formulier (en werd
-- daar zelfs altijd op null gezet — aparte bug-fix in client).
--
-- Nieuw: cc_manager, sales_manager én de toegewezen sales_rep kunnen de
-- datum los aanpassen op de appointments-pagina. Later (via Lemlist)
-- willen we hier ook automatisch de bevestigde datum inschieten, en op
-- basis van (datum + 1 dag) een reminder-mail naar de sales rep sturen
-- voor feedback. Deze RPC is de single write-path.
--
-- Authorisatie identiek aan dismiss_appointment.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_appointment_date(
  p_call_record_id UUID,
  p_appointment_date TIMESTAMPTZ  -- NULL = wissen
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id      UUID := auth.uid();
  v_project_id   UUID;
  v_sales_rep_id UUID;
  v_role         TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Niet ingelogd' USING ERRCODE = '42501';
  END IF;

  -- Project + huidige sales_rep opzoeken
  SELECT u.project_id, af.sales_rep_id
    INTO v_project_id, v_sales_rep_id
  FROM public.call_records cr
  JOIN public.uploads u ON u.id = cr.upload_id
  LEFT JOIN public.appointment_feedback af ON af.call_record_id = cr.id
  WHERE cr.id = p_call_record_id;

  IF v_project_id IS NULL THEN
    RAISE EXCEPTION 'Afspraak niet gevonden' USING ERRCODE = 'P0002';
  END IF;

  -- Rol binnen dit project → fallback op globale rol.
  SELECT role INTO v_role
  FROM public.project_members
  WHERE project_id = v_project_id AND profile_id = v_user_id
  LIMIT 1;

  IF v_role IS NULL THEN
    SELECT role INTO v_role FROM public.profiles WHERE id = v_user_id;
  END IF;

  IF v_role NOT IN ('cc_manager', 'sales_manager')
     AND v_sales_rep_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'Geen rechten om deze afspraakdatum te wijzigen' USING ERRCODE = '42501';
  END IF;

  -- Upsert. Als er nog geen feedback-row is, maken we er één met alleen
  -- de datum + eventueel de sales_rep_id die deze wijziging doet (zodat de
  -- rep-toewijzing niet verloren gaat als de manager de datum zet vóór er
  -- feedback is). Bestaande rijen krijgen alleen appointment_date update.
  INSERT INTO public.appointment_feedback (call_record_id, sales_rep_id, appointment_date)
  VALUES (p_call_record_id, COALESCE(v_sales_rep_id, v_user_id), p_appointment_date)
  ON CONFLICT (call_record_id) DO UPDATE
    SET appointment_date = EXCLUDED.appointment_date;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_appointment_date(UUID, TIMESTAMPTZ) TO authenticated;
