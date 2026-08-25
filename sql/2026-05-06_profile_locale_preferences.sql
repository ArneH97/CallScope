-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: locale + regional preferences op profiles
-- Datum:    2026-05-06
-- Reden:    CallScope wordt meertalig (NL + EN als eerste pass, FR/DE later)
--           en moet correct datums, getallen, en munt tonen volgens elke
--           gebruikers-context. Bij onboarding kiest de user expliciet:
--             - locale         (interface-taal)
--             - country        (voor BTW + standaard regionale formats)
--             - date_format    (DD/MM/YYYY vs MM/DD/YYYY vs YYYY-MM-DD)
--             - currency       (EUR/USD/GBP — gebruikt door kost-metrics)
--             - timezone       (voor weekly-hour-confirmations + cron)
--
--           We zetten DEFAULTS die overeenkomen met de huidige Belgische
--           NL-default zodat bestaande users niets merken.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS locale       text NOT NULL DEFAULT 'nl'
    CHECK (locale IN ('nl', 'en', 'fr', 'de')),
  ADD COLUMN IF NOT EXISTS country      text NOT NULL DEFAULT 'BE'
    CHECK (length(country) = 2),                              -- ISO 3166-1 alpha-2
  ADD COLUMN IF NOT EXISTS date_format  text NOT NULL DEFAULT 'DD/MM/YYYY'
    CHECK (date_format IN ('DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD')),
  ADD COLUMN IF NOT EXISTS currency     text NOT NULL DEFAULT 'EUR'
    CHECK (length(currency) = 3),                             -- ISO 4217
  ADD COLUMN IF NOT EXISTS timezone     text NOT NULL DEFAULT 'Europe/Brussels',
  -- Heeft de user de onboarding-stap voor preferences al doorlopen? Zo niet
  -- tonen we de modal bij eerstvolgende dashboard-bezoek.
  ADD COLUMN IF NOT EXISTS preferences_set_at timestamptz;

-- Backfill: alle bestaande users hebben de defaults al via DEFAULT-clause,
-- maar we markeren ze ook als "preferences set" zodat ze niet alsnog de
-- onboarding-modal te zien krijgen (zou storend zijn voor bestaande klanten).
UPDATE public.profiles
SET preferences_set_at = COALESCE(preferences_set_at, created_at, now())
WHERE preferences_set_at IS NULL;

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS preferences_set_at;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS timezone;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS currency;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS date_format;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS country;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS locale;
