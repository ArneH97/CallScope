-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: upload_summary view — tel uit call_records, niet uit analyses
-- Datum:    2026-04-29
-- Reden:    De vorige view las total_calls/reached/appointments/callbacks uit
--           de `analyses`-tabel. Elke upload heeft zijn eigen analyses-rij met
--           snapshot-counts van toen de AI hem verwerkte. Na dedup-upsert worden
--           call_records verplaatst naar de nieuwste upload, maar oude analyses
--           blijven hangen met hun originele tellingen. SUM over alle uploads
--           = veelvoud van het echte aantal records.
--
--           Fix: tel rechtstreeks uit call_records via een LATERAL join. Lege
--           uploads (na dedup) tellen automatisch 0. Som = correct aantal.
--
--           objections + rapport_text blijven uit analyses komen — dat zijn
--           AI-output velden die niet uit raw call_records herleidbaar zijn.
-- ────────────────────────────────────────────────────────────────────────────

-- LET OP: kolomvolgorde MOET identiek blijven aan de oude view, anders weigert
-- CREATE OR REPLACE met "cannot change name of view column ...". Daarom geen
-- nieuwe kolommen tussenvoegen; eventuele extra's append je aan het einde.
CREATE OR REPLACE VIEW public.upload_summary AS
SELECT
  u.id,
  u.project_id,
  u.caller_id,
  u.filename,
  u.tool,
  u.status,
  u.uploaded_at,
  p.full_name           AS caller_name,
  cc.name               AS call_center_name,
  proj.name             AS project_name,
  -- Cast naar int: COUNT(*) returnt bigint, maar de oude view had integer.
  -- CREATE OR REPLACE weigert type-wijziging dus we casten expliciet.
  COALESCE(stats.total_calls, 0)::int   AS total_calls,
  COALESCE(stats.reached, 0)::int       AS reached,
  COALESCE(stats.appointments, 0)::int  AS appointments,
  COALESCE(stats.callbacks, 0)::int     AS callbacks,
  a.objections,
  a.rapport_text,
  CASE
    WHEN COALESCE(stats.reached, 0) > 0
    THEN ROUND((COALESCE(stats.appointments, 0)::numeric / stats.reached) * 100, 1)
    ELSE NULL
  END AS conversion_pct
FROM public.uploads u
LEFT JOIN public.profiles p          ON p.id   = u.caller_id
LEFT JOIN public.call_centers cc     ON cc.id  = u.call_center_id
LEFT JOIN public.projects proj       ON proj.id = u.project_id
LEFT JOIN public.analyses a          ON a.upload_id = u.id
LEFT JOIN LATERAL (
  SELECT
    COUNT(*)                                            AS total_calls,
    COUNT(*) FILTER (
      WHERE cr.status IS NOT NULL
        AND cr.status <> ''
        AND cr.status NOT ILIKE '%voicemail%'
        AND cr.status NOT ILIKE '%no answer%'
        AND cr.status NOT ILIKE '%niet bereikt%'
        AND cr.status NOT ILIKE '%not reached%'
    )                                                   AS reached,
    COUNT(*) FILTER (
      WHERE cr.status ILIKE '%afspraak%'
         OR cr.status ILIKE '%appointment%'
    )                                                   AS appointments,
    COUNT(*) FILTER (
      WHERE cr.status ILIKE '%callback%'
         OR cr.status ILIKE '%terugbel%'
         OR cr.status ILIKE '%follow%up%'
    )                                                   AS callbacks
  FROM public.call_records cr
  WHERE cr.upload_id = u.id
) stats ON TRUE;

GRANT SELECT ON public.upload_summary TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
