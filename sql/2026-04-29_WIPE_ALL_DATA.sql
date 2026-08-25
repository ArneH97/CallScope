-- ────────────────────────────────────────────────────────────────────────────
-- ⚠️  WIPE — alle data uit alle tabellen verwijderen
-- ⚠️  DESTRUCTIEF, NIET TERUG TE DRAAIEN
-- Datum: 2026-04-29
--
-- Bedoeling: schone test van 0 af aan. Alle uploads, projecten, profielen,
-- call centers en auth-users worden verwijderd. Het schema (tabellen + kolommen
-- + indexes + views + RLS-policies) blijft staan.
--
-- HOE TE GEBRUIKEN:
-- 1. Open Supabase → SQL Editor → New query
-- 2. Plak dit hele bestand
-- 3. Run
-- 4. Verifieer in Supabase → Table Editor dat alle tabellen leeg zijn
-- 5. Verifieer in Supabase → Authentication → Users dat de lijst leeg is
-- 6. Ga naar callscope.be → Registreren → maak je nieuwe testaccount aan
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Public schema — children eerst (CASCADE pakt alles vanzelf, maar voor
--    duidelijkheid ook expliciet) ----------------------------------------------
TRUNCATE TABLE
  public.appointment_feedback,
  public.analyses,
  public.call_records,
  public.uploads,
  public.report_shares,
  public.project_members,
  public.project_call_centers,
  public.projects,
  public.call_center_members,
  public.call_centers,
  public.profiles
RESTART IDENTITY CASCADE;


-- 2. Auth schema — alle gebruikers verwijderen ------------------------------
-- Dit verwijdert ook automatisch identity-rijen, refresh tokens, sessies, ...
-- (Supabase heeft cascading FKs op auth.users.id)
DELETE FROM auth.users;


-- ────────────────────────────────────────────────────────────────────────────
-- POST-CHECKS — run deze SELECTs apart om te bevestigen dat alles leeg is
-- ────────────────────────────────────────────────────────────────────────────
-- SELECT count(*) FROM public.profiles;             -- moet 0 zijn
-- SELECT count(*) FROM public.projects;             -- moet 0 zijn
-- SELECT count(*) FROM public.call_records;         -- moet 0 zijn
-- SELECT count(*) FROM auth.users;                  -- moet 0 zijn
