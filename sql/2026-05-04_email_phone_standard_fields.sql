-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: email + phone als standaard kolommen op call_records
-- Datum:    2026-05-04
-- Reden:    Email en telefoon hoorden eigenlijk nooit in custom_fields. Ze
--           zijn fundamenteel voor lead-identificatie (HubSpot lookup,
--           dedup, contact-info in UI). Door ze te verheffen tot standaard
--           kolommen kan upload-mapping ze direct herkennen, en HubSpot/
--           Google sync hoeven niet meer in custom_fields te wroeten.
--
--           Backwards-compat: bestaande custom_fields.email/mail/e-mail/
--           emailadres/phone/telefoon/tel/gsm/mobile/mobiel waardes worden
--           gemigreerd naar de nieuwe kolommen.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Kolommen toevoegen ─────────────────────────────────────────────────────
ALTER TABLE public.call_records
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS phone text;

-- Index op email — voor snelle lookups vanuit HubSpot sync, dedup en filters
CREATE INDEX IF NOT EXISTS idx_call_records_email
  ON public.call_records (lower(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_call_records_phone
  ON public.call_records (phone)
  WHERE phone IS NOT NULL;


-- 2. Backfill uit custom_fields ────────────────────────────────────────────
-- We checken alle bekende email-aliassen, neem de eerste niet-lege match.
-- COALESCE met genest custom_fields ->> 'key' patroon.
UPDATE public.call_records
SET email = COALESCE(
  NULLIF(trim(custom_fields ->> 'email'),       ''),
  NULLIF(trim(custom_fields ->> 'Email'),       ''),
  NULLIF(trim(custom_fields ->> 'EMAIL'),       ''),
  NULLIF(trim(custom_fields ->> 'mail'),        ''),
  NULLIF(trim(custom_fields ->> 'Mail'),        ''),
  NULLIF(trim(custom_fields ->> 'e-mail'),      ''),
  NULLIF(trim(custom_fields ->> 'E-mail'),      ''),
  NULLIF(trim(custom_fields ->> 'emailadres'),  ''),
  NULLIF(trim(custom_fields ->> 'Emailadres'),  '')
)
WHERE email IS NULL
  AND custom_fields IS NOT NULL
  AND custom_fields::text <> '{}';

UPDATE public.call_records
SET phone = COALESCE(
  NULLIF(trim(custom_fields ->> 'phone'),     ''),
  NULLIF(trim(custom_fields ->> 'Phone'),     ''),
  NULLIF(trim(custom_fields ->> 'telefoon'),  ''),
  NULLIF(trim(custom_fields ->> 'Telefoon'),  ''),
  NULLIF(trim(custom_fields ->> 'tel'),       ''),
  NULLIF(trim(custom_fields ->> 'Tel'),       ''),
  NULLIF(trim(custom_fields ->> 'gsm'),       ''),
  NULLIF(trim(custom_fields ->> 'GSM'),       ''),
  NULLIF(trim(custom_fields ->> 'mobile'),    ''),
  NULLIF(trim(custom_fields ->> 'Mobile'),    ''),
  NULLIF(trim(custom_fields ->> 'mobiel'),    ''),
  NULLIF(trim(custom_fields ->> 'Mobiel'),    '')
)
WHERE phone IS NULL
  AND custom_fields IS NOT NULL
  AND custom_fields::text <> '{}';


NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS public.idx_call_records_email;
-- DROP INDEX IF EXISTS public.idx_call_records_phone;
-- ALTER TABLE public.call_records DROP COLUMN IF EXISTS email;
-- ALTER TABLE public.call_records DROP COLUMN IF EXISTS phone;
