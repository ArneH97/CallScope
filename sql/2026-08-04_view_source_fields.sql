-- ────────────────────────────────────────────────────────────────────────────
-- Voeg bron-info toe aan appointments_with_feedback view.
--
-- Doel: op de appointments-pagina kunnen tonen uit welke bron een afspraak
-- komt (Google Sheet naam, Lemlist campaign, manuele upload). We voegen
-- daarvoor `upload_tool`, `upload_filename` en `custom_fields` toe aan de
-- view zodat de client geen aparte join hoeft te doen.
--
-- View definitie hergebruikt structuur van 2026-04-30_dealstage.sql; deze
-- migratie DROP + CREATE zodat de nieuwe kolommen erbij komen.
-- ────────────────────────────────────────────────────────────────────────────

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
  u.tool             AS upload_tool,      -- 'google_sheets' | 'lemlist' | 'manual' | ...
  u.filename         AS upload_filename,  -- "Sheet-naam — 2026-07-30" of "Lemlist sync — ..."

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
WHERE cr.status ILIKE ANY (ARRAY['%afspraak%', '%appointment%'])
   OR af.id IS NOT NULL;

GRANT SELECT ON public.appointments_with_feedback TO anon, authenticated;
