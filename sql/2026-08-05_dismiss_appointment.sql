-- ────────────────────────────────────────────────────────────────────────────
-- Manueel een afspraak "geen afspraak" verklaren.
--
-- Achtergrond: soms wordt een call door de cold caller als "afspraak" gelogd
-- (bv. in de Google Sheet), maar blijkt achteraf dat het geen echte afspraak
-- was (misverstand, klant belt terug af binnen 5 min, verkeerde categorie…).
-- De sales manager / cc_manager wil dan die afspraak uit de lijst kunnen
-- halen zónder de call zelf te verwijderen (want er is wél gebeld → moet
-- blijven meetellen in de Gebeld/Bereikt statistieken).
--
-- Oplossing: nieuwe boolean-kolom op call_records. TRUE = deze call
-- verschijnt niet meer in de appointments_with_feedback view.
-- Nieuwe syncs (google/lemlist/hubspot) laten deze kolom ongemoeid want
-- ze doen ON CONFLICT DO UPDATE zonder dismissed_as_appointment op te
-- geven — Postgres overschrijft alleen expliciet vermelde kolommen.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.call_records
  ADD COLUMN IF NOT EXISTS dismissed_as_appointment BOOLEAN NOT NULL DEFAULT FALSE;

-- Index niet nodig — de kolom wordt enkel in de view-filter gebruikt en
-- appointments-tabel is klein genoeg (< 100k rijen realistisch).

-- View recreëren met dismiss-filter.
DROP VIEW IF EXISTS public.appointments_with_feedback CASCADE;

CREATE VIEW public.appointments_with_feedback AS
SELECT
  cr.id              AS call_record_id,
  cr.lead_name,
  cr.call_date,
  cr.notes           AS caller_notes,
  cr.custom_fields   AS custom_fields,
  cr.dealstage_raw,
  cr.dealstage_category,
  cr.dealstage_synced_at,

  u.project_id       AS project_id,
  u.call_center_id   AS call_center_id,
  cc.name            AS call_center_name,
  u.tool             AS upload_tool,
  u.filename         AS upload_filename,

  u.caller_id        AS caller_id,
  caller.full_name   AS caller_name,

  af.appointment_status,
  af.outcome,
  af.quality_rating,
  af.notes              AS sales_notes,
  af.appointment_date,

  af.sales_rep_id,
  sales_rep.full_name   AS sales_rep_name
FROM public.call_records cr
JOIN public.uploads      u                   ON u.id  = cr.upload_id
JOIN public.call_centers cc                  ON cc.id = u.call_center_id
LEFT JOIN public.profiles            caller      ON caller.id      = u.caller_id
LEFT JOIN public.appointment_feedback af         ON af.call_record_id = cr.id
LEFT JOIN public.profiles            sales_rep   ON sales_rep.id   = af.sales_rep_id
WHERE cr.dismissed_as_appointment = FALSE
  AND (
       cr.status ILIKE ANY (ARRAY['%afspraak%', '%appointment%'])
    OR af.id IS NOT NULL
  );

GRANT SELECT ON public.appointments_with_feedback TO anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- RPC voor "geen afspraak"-actie. Één functie zodat de client geen aparte
-- DELETE + UPDATE hoeft te sturen (atomiciteit + duidelijke authorisatie).
--
-- Wie mag dismissen?
--   • cc_manager van het project (project owner)
--   • sales_manager van het project
--   • sales_rep die aan de afspraak is toegewezen
-- Rest krijgt 42501-permission-denied.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.dismiss_appointment(p_call_record_id UUID)
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

  -- Rol van deze user binnen dit project
  SELECT role INTO v_role
  FROM public.project_members
  WHERE project_id = v_project_id AND profile_id = v_user_id
  LIMIT 1;

  -- Global role fallback (owner = cc_manager op profiles-niveau)
  IF v_role IS NULL THEN
    SELECT role INTO v_role FROM public.profiles WHERE id = v_user_id;
  END IF;

  IF v_role NOT IN ('cc_manager', 'sales_manager')
     AND v_sales_rep_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'Geen rechten om deze afspraak te dismissen' USING ERRCODE = '42501';
  END IF;

  -- Uitvoeren: markeer als dismissed, verwijder eventueel feedback.
  UPDATE public.call_records
     SET dismissed_as_appointment = TRUE
   WHERE id = p_call_record_id;

  DELETE FROM public.appointment_feedback
   WHERE call_record_id = p_call_record_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.dismiss_appointment(UUID) TO authenticated;
