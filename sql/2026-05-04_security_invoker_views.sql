-- ────────────────────────────────────────────────────────────────────────────
-- Fix Supabase Security Advisor: "Security Definer View"
--
-- Twee views (public.lead_status, public.appointments_with_feedback) draaien
-- nu met de rechten van de view-creator (postgres) → ze bypassen de RLS van
-- de onderliggende tabellen (call_records, uploads, appointment_feedback, …).
--
-- Fix: zet ze om naar SECURITY INVOKER. Vanaf nu gelden de RLS-policies van
-- de querying user, zoals het hoort.
--
-- Side-effect: queries op deze views vanuit de frontend respecteren nu RLS.
-- Als iets breekt → de RLS-policies op de onderliggende tabellen waren al
-- correct ingesteld bij de "RLS comprehensive reset" migratie, dus dit zou
-- transparant moeten zijn. Mocht een query toch leeg terugkomen die voorheen
-- data gaf, dan ontbreekt er nog een SELECT-policy op de bron-tabel.
-- ────────────────────────────────────────────────────────────────────────────

ALTER VIEW public.appointments_with_feedback SET (security_invoker = true);
ALTER VIEW public.lead_status                SET (security_invoker = true);

-- Optioneel: ook upload_summary defensief op invoker zetten — Supabase heeft
-- hem nog niet aangevlagd, maar het is dezelfde best-practice.
ALTER VIEW public.upload_summary SET (security_invoker = true);

NOTIFY pgrst, 'reload schema';
