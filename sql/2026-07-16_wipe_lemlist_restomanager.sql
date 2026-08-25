-- ────────────────────────────────────────────────────────────────────────────
-- One-off: wis alle Lemlist-imports voor RestoManager zodat we opnieuw
-- kunnen syncen met de nieuwe (correcte) dedup-logic.
--
-- Waarom: de vroegere sync gebruikte external_id = leadId + dedup per
-- (leadId, call_date), waardoor meerdere calls naar dezelfde lead op één
-- dag als 1 rij werden opgeslagen. De nieuwe sync gebruikt external_id =
-- activity._id → elke Lemlist-activity een aparte rij. Oude en nieuwe
-- records zouden naast elkaar bestaan als we niet eerst opkuisen.
--
-- Wat blijft: Google Sheet-uploads, HubSpot-uploads, manuele uploads,
-- appointment_bookings, lead_pool. Enkel `tool='lemlist'` wordt geraakt.
-- Project-scope: 214558ad-7ad9-4018-857d-ef1087f5f812 (= RestoManager).
--
-- Volgorde is belangrijk door foreign keys:
--   1. analyses (hangen aan uploads via upload_id)
--   2. call_records (hangen aan uploads via upload_id)
--   3. uploads zelf
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 0. Preview: hoeveel gaan we wissen?
SELECT 'BEFORE — Lemlist uploads' AS label, COUNT(*) AS n
  FROM public.uploads
 WHERE project_id = '214558ad-7ad9-4018-857d-ef1087f5f812'
   AND tool       = 'lemlist'
UNION ALL
SELECT 'BEFORE — Lemlist call_records', COUNT(*)
  FROM public.call_records cr
  JOIN public.uploads u ON u.id = cr.upload_id
 WHERE u.project_id = '214558ad-7ad9-4018-857d-ef1087f5f812'
   AND u.tool       = 'lemlist';

-- 1. Analyses opgehangen aan Lemlist-uploads
DELETE FROM public.analyses
 WHERE upload_id IN (
   SELECT id FROM public.uploads
    WHERE project_id = '214558ad-7ad9-4018-857d-ef1087f5f812'
      AND tool       = 'lemlist'
 );

-- 2. Call records via Lemlist-uploads
DELETE FROM public.call_records
 WHERE upload_id IN (
   SELECT id FROM public.uploads
    WHERE project_id = '214558ad-7ad9-4018-857d-ef1087f5f812'
      AND tool       = 'lemlist'
 );

-- 3. De uploads zelf
DELETE FROM public.uploads
 WHERE project_id = '214558ad-7ad9-4018-857d-ef1087f5f812'
   AND tool       = 'lemlist';

-- 4. Verificatie: alles op nul + andere tools ongemoeid
SELECT 'AFTER — Lemlist uploads' AS label, COUNT(*) AS n
  FROM public.uploads
 WHERE project_id = '214558ad-7ad9-4018-857d-ef1087f5f812'
   AND tool       = 'lemlist'
UNION ALL
SELECT 'AFTER — Andere uploads (bewaard)', COUNT(*)
  FROM public.uploads
 WHERE project_id = '214558ad-7ad9-4018-857d-ef1087f5f812'
   AND tool      != 'lemlist'
UNION ALL
SELECT 'AFTER — Call records (andere bronnen)', COUNT(*)
  FROM public.call_records cr
  JOIN public.uploads u ON u.id = cr.upload_id
 WHERE u.project_id = '214558ad-7ad9-4018-857d-ef1087f5f812';

COMMIT;
