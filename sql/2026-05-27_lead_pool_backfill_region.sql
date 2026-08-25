-- ────────────────────────────────────────────────────────────────────────────
-- One-off backfill: vul `region` in voor bestaande lead_pool-rijen.
-- Datum:  2026-05-27 (rev 2 — exacte 4-cijferige postcode mapping)
-- Vereist: 2026-05-27_lead_pool_region.sql moet al gerund zijn (kolom bestaat).
--
-- Bron van de mapping: west-vlaanderen-mapping-v3.csv (RestoManager).
-- 101 unieke postcodes, geen conflicten. Dezelfde tabel zit hardcoded in
-- src/lib/regions.ts (POSTAL_TO_REGION). Bij wijzigingen daar: hier ook.
--
-- Idempotent: bestaande region-waardes worden NIET overschreven. Re-runs
-- kunnen veilig (b.v. wanneer nieuwe leads via upload geocoding-ok zijn
-- gemarkeerd maar door een ander pad geen region kregen).
-- ────────────────────────────────────────────────────────────────────────────

UPDATE public.lead_pool
   SET region = CASE LEFT(postal_code, 4)
     -- WVL-NW (Brugge & Kust-Noord) — 25 postcodes
     WHEN '8000' THEN 'WVL-NW' WHEN '8020' THEN 'WVL-NW' WHEN '8200' THEN 'WVL-NW'
     WHEN '8210' THEN 'WVL-NW' WHEN '8211' THEN 'WVL-NW' WHEN '8300' THEN 'WVL-NW'
     WHEN '8301' THEN 'WVL-NW' WHEN '8310' THEN 'WVL-NW' WHEN '8340' THEN 'WVL-NW'
     WHEN '8370' THEN 'WVL-NW' WHEN '8377' THEN 'WVL-NW' WHEN '8380' THEN 'WVL-NW'
     WHEN '8400' THEN 'WVL-NW' WHEN '8420' THEN 'WVL-NW' WHEN '8421' THEN 'WVL-NW'
     WHEN '8430' THEN 'WVL-NW' WHEN '8431' THEN 'WVL-NW' WHEN '8432' THEN 'WVL-NW'
     WHEN '8433' THEN 'WVL-NW' WHEN '8434' THEN 'WVL-NW' WHEN '8450' THEN 'WVL-NW'
     WHEN '8460' THEN 'WVL-NW' WHEN '8470' THEN 'WVL-NW' WHEN '8490' THEN 'WVL-NW'
     WHEN '8730' THEN 'WVL-NW'

     -- WVL-W (Westhoek) — 30 postcodes
     WHEN '8480' THEN 'WVL-W'  WHEN '8600' THEN 'WVL-W'  WHEN '8620' THEN 'WVL-W'
     WHEN '8630' THEN 'WVL-W'  WHEN '8640' THEN 'WVL-W'  WHEN '8647' THEN 'WVL-W'
     WHEN '8650' THEN 'WVL-W'  WHEN '8660' THEN 'WVL-W'  WHEN '8670' THEN 'WVL-W'
     WHEN '8680' THEN 'WVL-W'  WHEN '8690' THEN 'WVL-W'  WHEN '8691' THEN 'WVL-W'
     WHEN '8900' THEN 'WVL-W'  WHEN '8902' THEN 'WVL-W'  WHEN '8904' THEN 'WVL-W'
     WHEN '8906' THEN 'WVL-W'  WHEN '8908' THEN 'WVL-W'  WHEN '8920' THEN 'WVL-W'
     WHEN '8950' THEN 'WVL-W'  WHEN '8951' THEN 'WVL-W'  WHEN '8952' THEN 'WVL-W'
     WHEN '8953' THEN 'WVL-W'  WHEN '8954' THEN 'WVL-W'  WHEN '8956' THEN 'WVL-W'
     WHEN '8957' THEN 'WVL-W'  WHEN '8958' THEN 'WVL-W'  WHEN '8970' THEN 'WVL-W'
     WHEN '8972' THEN 'WVL-W'  WHEN '8978' THEN 'WVL-W'  WHEN '8980' THEN 'WVL-W'

     -- WVL-M (Roeselare-Tielt) — 19 postcodes
     WHEN '8610' THEN 'WVL-M'  WHEN '8700' THEN 'WVL-M'  WHEN '8710' THEN 'WVL-M'
     WHEN '8720' THEN 'WVL-M'  WHEN '8740' THEN 'WVL-M'  WHEN '8750' THEN 'WVL-M'
     WHEN '8760' THEN 'WVL-M'  WHEN '8770' THEN 'WVL-M'  WHEN '8780' THEN 'WVL-M'
     WHEN '8800' THEN 'WVL-M'  WHEN '8810' THEN 'WVL-M'  WHEN '8820' THEN 'WVL-M'
     WHEN '8830' THEN 'WVL-M'  WHEN '8840' THEN 'WVL-M'  WHEN '8850' THEN 'WVL-M'
     WHEN '8851' THEN 'WVL-M'  WHEN '8870' THEN 'WVL-M'  WHEN '8880' THEN 'WVL-M'
     WHEN '8890' THEN 'WVL-M'

     -- WVL-Z (Kortrijk-Waregem) — 27 postcodes
     WHEN '8501' THEN 'WVL-Z'  WHEN '8510' THEN 'WVL-Z'  WHEN '8511' THEN 'WVL-Z'
     WHEN '8520' THEN 'WVL-Z'  WHEN '8530' THEN 'WVL-Z'  WHEN '8531' THEN 'WVL-Z'
     WHEN '8540' THEN 'WVL-Z'  WHEN '8550' THEN 'WVL-Z'  WHEN '8551' THEN 'WVL-Z'
     WHEN '8552' THEN 'WVL-Z'  WHEN '8553' THEN 'WVL-Z'  WHEN '8554' THEN 'WVL-Z'
     WHEN '8560' THEN 'WVL-Z'  WHEN '8570' THEN 'WVL-Z'  WHEN '8572' THEN 'WVL-Z'
     WHEN '8573' THEN 'WVL-Z'  WHEN '8580' THEN 'WVL-Z'  WHEN '8581' THEN 'WVL-Z'
     WHEN '8582' THEN 'WVL-Z'  WHEN '8587' THEN 'WVL-Z'  WHEN '8790' THEN 'WVL-Z'
     WHEN '8791' THEN 'WVL-Z'  WHEN '8792' THEN 'WVL-Z'  WHEN '8793' THEN 'WVL-Z'
     WHEN '8860' THEN 'WVL-Z'  WHEN '8930' THEN 'WVL-Z'  WHEN '8940' THEN 'WVL-Z'

     -- Buiten BE-WVL of niet in mapping: geen sub-regio (volle-provincie
     -- match werkt nog wel via lead.province + rep die "WVL" / provincie tagt).
     ELSE NULL
   END
 WHERE region         IS NULL
   AND postal_code    IS NOT NULL
   AND geocode_status = 'ok';

-- ────────────────────────────────────────────────────────────────────────────
-- Verificatie: telt hoeveel leads nu per regio gemapt zijn, en hoeveel
-- met ok-geocode toch geen regio kregen. Die laatste groep zijn ofwel:
--   - niet-WVL leads (Antwerpen, Limburg, …) → matched via province, niet region
--   - WVL-leads met postcode buiten de 101-mapping → matched via province
-- Beide zijn normaal en blijven via de provincie-fallback in slot-finder werken.
-- ────────────────────────────────────────────────────────────────────────────
SELECT
  COALESCE(region, '(geen sub-regio)') AS region,
  COUNT(*)                              AS lead_count
  FROM public.lead_pool
 WHERE geocode_status = 'ok'
 GROUP BY region
 ORDER BY lead_count DESC;
