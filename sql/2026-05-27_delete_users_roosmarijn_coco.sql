-- ────────────────────────────────────────────────────────────────────────────
-- One-off: verwijder 2 verkeerd uitgenodigde users (cold_caller i.p.v.
--          sales_rep). Run in Supabase SQL editor.
-- Datum:   2026-05-27 (rev 2)
--
-- Rev 2 fix: project_invites zoekt op email (geen invited_user_id kolom —
--            invites worden token-based op email opgeslagen).
--
-- Aanpak: één DO-block dat:
--   1) De user_ids opzoekt via auth.users.email
--   2) Alle bezittingen + lidmaatschappen wist (in afhankelijkheid-volgorde)
--   3) De profiles-rij wist
--   4) De auth.users-rij wist
--   5) Eventuele open project_invites op deze emails wist (op email-key)
--
-- Veiligheid:
--   - Wrapped in een DO-block. Bij fout in stap 2: transactie rolt terug.
--   - Verwerkt 0/1/2 matches netjes.
--
-- Hierna: opnieuw uitnodigen via de wizard, deze keer als sales_rep.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_emails text[]  := ARRAY['roosmarijn@restomanager.net', 'coco@restomanager.net'];
  v_uids   uuid[];
  v_uid    uuid;
  v_email  text;
  v_found  int;
BEGIN
  -- 1. Zoek alle matchende user_ids (case-insensitive)
  SELECT array_agg(id)
    INTO v_uids
    FROM auth.users
   WHERE lower(email) = ANY(SELECT lower(unnest(v_emails)));

  v_found := COALESCE(array_length(v_uids, 1), 0);

  -- 2. Pending invites op deze emails wissen — ook als er geen account
  --    bestond, kan er een outstanding invite zijn die we willen opruimen.
  DELETE FROM public.project_invites
   WHERE lower(email) = ANY(SELECT lower(unnest(v_emails)));

  IF v_found = 0 THEN
    RAISE NOTICE 'Geen users in auth.users met deze emails (eventuele pending invites zijn wel gewist).';
    RETURN;
  END IF;

  RAISE NOTICE 'Aantal gevonden users om te verwijderen: %', v_found;

  FOREACH v_uid IN ARRAY v_uids LOOP
    SELECT email INTO v_email FROM auth.users WHERE id = v_uid;
    RAISE NOTICE 'Verwijderen: % (%)', v_email, v_uid;

    -- Project lidmaatschappen
    DELETE FROM public.project_members           WHERE profile_id   = v_uid;

    -- Call center lidmaatschappen (legacy / freelance)
    DELETE FROM public.call_center_members       WHERE profile_id   = v_uid;

    -- Sales-rep gerelateerde feedback
    DELETE FROM public.appointment_feedback      WHERE sales_rep_id = v_uid;

    -- Coaching insights als cold_caller
    DELETE FROM public.caller_coaching_insights  WHERE caller_id    = v_uid;

    -- Caller-rates en uren-bevestigingen
    DELETE FROM public.project_caller_rates      WHERE caller_id    = v_uid;
    DELETE FROM public.weekly_hour_confirmations WHERE caller_id    = v_uid;

    -- Uploads (cascadeert naar call_records via FK indien aanwezig)
    DELETE FROM public.uploads                   WHERE caller_id    = v_uid;

    -- Google Sheet bindings
    DELETE FROM public.project_google_sheets     WHERE caller_id    = v_uid;

    -- OAuth-integraties
    DELETE FROM public.google_integrations       WHERE user_id      = v_uid;
    DELETE FROM public.hubspot_integrations      WHERE user_id      = v_uid;
    DELETE FROM public.lemlist_integrations      WHERE user_id      = v_uid;

    -- Profile rij (ON DELETE CASCADE op auth.users zou dit ook regelen)
    DELETE FROM public.profiles                  WHERE id           = v_uid;

    -- Auth.users — de eigenlijke account
    DELETE FROM auth.users                       WHERE id           = v_uid;

  END LOOP;

  RAISE NOTICE 'Klaar. % user(s) volledig verwijderd.', v_found;
END $$;

-- Verificatie: deze query mag 0 rijen teruggeven
SELECT id, email
  FROM auth.users
 WHERE lower(email) IN ('roosmarijn@restomanager.net', 'coco@restomanager.net');
