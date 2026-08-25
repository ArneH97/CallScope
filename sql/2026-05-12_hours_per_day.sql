-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: per-dag uren-bevestigingen (Ma-Vr) op weekly_hour_confirmations
-- Datum:    2026-05-12
-- Reden:    Cc_manager wil per cold caller per werkdag de uren invullen.
--           Bv. "Arne belde maandag niet, Dieter wel" — voorheen kon enkel
--           het weektotaal worden bevestigd, wat geen onderscheid tussen
--           dagen toeliet.
--
--           `hours_actual` blijft als running total (= sum van Ma-Vr) zodat
--           bestaande queries en cost-metrics zonder wijziging blijven werken.
--           Bij elke save berekent de page hours_actual = sum.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.weekly_hour_confirmations
  ADD COLUMN IF NOT EXISTS hours_mon numeric NOT NULL DEFAULT 0
    CHECK (hours_mon >= 0 AND hours_mon <= 24),
  ADD COLUMN IF NOT EXISTS hours_tue numeric NOT NULL DEFAULT 0
    CHECK (hours_tue >= 0 AND hours_tue <= 24),
  ADD COLUMN IF NOT EXISTS hours_wed numeric NOT NULL DEFAULT 0
    CHECK (hours_wed >= 0 AND hours_wed <= 24),
  ADD COLUMN IF NOT EXISTS hours_thu numeric NOT NULL DEFAULT 0
    CHECK (hours_thu >= 0 AND hours_thu <= 24),
  ADD COLUMN IF NOT EXISTS hours_fri numeric NOT NULL DEFAULT 0
    CHECK (hours_fri >= 0 AND hours_fri <= 24);

-- Backfill: bestaande rijen hebben enkel hours_actual ingevuld. Verdeel
-- dat evenredig over Ma-Vr (= hours_actual / 5) zodat de per-dag view
-- iets zinvols toont wanneer de cc_manager een oude week heropent. De
-- gebruiker kan dan alsnog corrigeren en opnieuw bevestigen.
--
-- We doen dit enkel waar alle 5 dag-kolommen nog op 0 staan (=newly added
-- columns), om idempotency te garanderen — herhaaldelijk runnen van de
-- migratie schrijft de backfill niet over manueel ingevulde data.
UPDATE public.weekly_hour_confirmations
SET hours_mon = hours_actual / 5,
    hours_tue = hours_actual / 5,
    hours_wed = hours_actual / 5,
    hours_thu = hours_actual / 5,
    hours_fri = hours_actual / 5
WHERE hours_actual > 0
  AND hours_mon = 0 AND hours_tue = 0 AND hours_wed = 0 AND hours_thu = 0 AND hours_fri = 0;

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- ALTER TABLE public.weekly_hour_confirmations DROP COLUMN IF EXISTS hours_fri;
-- ALTER TABLE public.weekly_hour_confirmations DROP COLUMN IF EXISTS hours_thu;
-- ALTER TABLE public.weekly_hour_confirmations DROP COLUMN IF EXISTS hours_wed;
-- ALTER TABLE public.weekly_hour_confirmations DROP COLUMN IF EXISTS hours_tue;
-- ALTER TABLE public.weekly_hour_confirmations DROP COLUMN IF EXISTS hours_mon;
