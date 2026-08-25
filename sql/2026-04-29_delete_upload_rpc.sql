-- ────────────────────────────────────────────────────────────────────────────
-- SECURITY DEFINER functie voor het verwijderen van een upload
-- Datum: 2026-04-29
-- Reden: Eén klik in de UI moet alle gerelateerde rijen opruimen:
--          - appointment_feedback (van call_records van deze upload)
--          - call_records (van deze upload)
--          - analyses (van deze upload)
--          - de upload-rij zelf
--        Plus authorisatie: alleen cc_manager van het project OF de caller
--        van de upload zelf mag deze actie uitvoeren.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.delete_upload(p_upload_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id   uuid;
  v_upload    public.uploads;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_upload FROM public.uploads WHERE id = p_upload_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Upload not found';
  END IF;

  -- Authorisatie: cc_manager van het project, of de caller zelf
  IF NOT (
    public.is_cc_manager_of_project(v_upload.project_id)
    OR v_upload.caller_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Not authorized to delete this upload';
  END IF;

  -- Cascade cleanup in volgorde (FK constraints respecteren)
  DELETE FROM public.appointment_feedback
  WHERE call_record_id IN (
    SELECT id FROM public.call_records WHERE upload_id = p_upload_id
  );

  DELETE FROM public.call_records WHERE upload_id = p_upload_id;
  DELETE FROM public.analyses     WHERE upload_id = p_upload_id;
  DELETE FROM public.uploads      WHERE id        = p_upload_id;
END $$;

GRANT EXECUTE ON FUNCTION public.delete_upload(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
