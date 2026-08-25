-- ────────────────────────────────────────────────────────────────────────────
-- One-off: verwijder Arne Halsberghe's Lemlist-imports uit RestoManager.
--
-- Waarom: Arne is cc_manager (niet actieve caller) in dit project. De vorige
-- sync-versie nam cc_managers automatisch mee als "mogelijke callers" via
-- call_centers.manager_id, waardoor zijn Lemlist activiteit werd
-- geïmporteerd. De nieuwe sync-versie neemt enkel expliciete cold_callers
-- uit project_members mee, dus toekomstige syncs bevatten Arne niet meer.
-- Deze SQL kuist zijn oude records op zodat de rapport-cijfers kloppen.
--
-- Scope:
--   - Project: 214558ad-7ad9-4018-857d-ef1087f5f812 (RestoManager)
--   - Caller:  3f0da49d-24df-4d35-a016-0014f1a596d2 (Arne Halsberghe)
--   - Bron:    tool='lemlist' (Google Sheets uploads blijven ongemoeid)
--
-- Volgorde belangrijk voor foreign keys:
--   1. analyses (hangen aan uploads)
--   2. call_records (hangen aan uploads)
--   3. uploads zelf
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 0. Preview: hoeveel gaan we wissen?
SELECT 'BEFORE — Arne Lemlist uploads' AS label, COUNT(*) AS n
  FROM public.uploads
 WHERE project_id = '214558ad-7ad9-4018-857d-ef1087f5f812'
   AND caller_id  = '3f0da49d-24df-4d35-a016-0014f1a596d2'
   AND tool       = 'lemlist'
UNION ALL
SELECT 'BEFORE — Arne Lemlist call_records', COUNT(*)
  FROM public.call_records cr
  JOIN public.uploads u ON u.id = cr.upload_id
 WHERE u.project_id = '214558ad-7ad9-4018-857d-ef1087f5f812'
   AND u.caller_id  = '3f0da49d-24df-4d35-a016-0014f1a596d2'
   AND u.tool       = 'lemlist';

-- 1. Analyses opgehangen aan Arne's Lemlist-uploads
DELETE FROM public.analyses
 WHERE upload_id IN (
   SELECT id FROM public.uploads
    WHERE project_id = '214558ad-7ad9-4018-857d-ef1087f5f812'
      AND caller_id  = '3f0da49d-24df-4d35-a016-0014f1a596d2'
      AND tool       = 'lemlist'
 );

-- 2. Call records via Arne's Lemlist-uploads
DELETE FROM public.call_records
 WHERE upload_id IN (
   SELECT id FROM public.uploads
    WHERE project_id = '214558ad-7ad9-4018-857d-ef1087f5f812'
      AND caller_id  = '3f0da49d-24df-4d35-a016-0014f1a596d2'
      AND tool       = 'lemlist'
 );

-- 3. De uploads zelf
DELETE FROM public.uploads
 WHERE project_id = '214558ad-7ad9-4018-857d-ef1087f5f812'
   AND caller_id  = '3f0da49d-24df-4d35-a016-0014f1a596d2'
   AND tool       = 'lemlist';

-- 4. Verificatie: Arne's Lemlist op nul, andere data intact
SELECT 'AFTER — Arne Lemlist uploads' AS label, COUNT(*) AS n
  FROM public.uploads
 WHERE project_id = '214558ad-7ad9-4018-857d-ef1087f5f812'
   AND caller_id  = '3f0da49d-24df-4d35-a016-0014f1a596d2'
   AND tool       = 'lemlist'
UNION ALL
SELECT 'AFTER — Dieter Lemlist uploads (bewaard)', COUNT(*)
  FROM public.uploads
 WHERE project_id = '214558ad-7ad9-4018-857d-ef1087f5f812'
   AND caller_id  = '000dcdda-5084-4c7b-a762-c07622b38960'
   AND tool       = 'lemlist'
UNION ALL
SELECT 'AFTER — Alle uploads voor project (samen)', COUNT(*)
  FROM public.uploads
 WHERE project_id = '214558ad-7ad9-4018-857d-ef1087f5f812';

COMMIT;
