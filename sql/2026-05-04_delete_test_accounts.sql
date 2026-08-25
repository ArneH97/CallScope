-- ────────────────────────────────────────────────────────────────────────────
-- Verwijder twee testaccounts:
--   1. bert@afsprakenmaker.be          (Bert Lambrecht — cold_caller)
--   2. arne.halsberghe1@gmail.com      (Arne — cc_manager, gmail-account)
--
-- Volgorde:
--   1) DELETE FROM public.profiles  → cascade naar project_members,
--      call_center_members, call_centers (en daarmee uploads + call_records)
--   2) DELETE FROM auth.users       → ruimt de auth-rij op
-- ────────────────────────────────────────────────────────────────────────────

-- ── 1) Verifieer de IDs ────────────────────────────────────────────────────
SELECT id, email, full_name, role
FROM public.profiles
WHERE email IN ('bert@afsprakenmaker.be', 'arne.halsberghe1@gmail.com');


-- ── 2) DELETE — eerst profiles (cascade), dan auth.users ───────────────────
DELETE FROM public.profiles
WHERE email IN ('bert@afsprakenmaker.be', 'arne.halsberghe1@gmail.com');

DELETE FROM auth.users
WHERE email IN ('bert@afsprakenmaker.be', 'arne.halsberghe1@gmail.com');


-- ── 3) Verificatie — beide queries moeten 0 rijen geven ───────────────────
SELECT id, email FROM public.profiles
WHERE email IN ('bert@afsprakenmaker.be', 'arne.halsberghe1@gmail.com');

SELECT id, email FROM auth.users
WHERE email IN ('bert@afsprakenmaker.be', 'arne.halsberghe1@gmail.com');
