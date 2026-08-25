-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: upload_source + feedback_source op projects + create_project RPC
-- Datum:    2026-04-30
-- Reden:    We hebben nu meerdere flow-varianten:
--             1. Manueel upload + manuele feedback
--             2. Google Sheets sync upload + manuele feedback
--             3. Google Sheets sync upload + feedback uit dezelfde sheet
--           Bij projectaanmaak moet de cc-manager deze keuzes ineens vastleggen
--           zodat dashboards/UI's weten welke flow van toepassing is. Later
--           komen er nog HubSpot, Aircall, Lemlist, ... bij.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Kolommen toevoegen, default 'manual' voor bestaande rijen ─────────────
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS upload_source   text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS feedback_source text NOT NULL DEFAULT 'manual';

-- Toegestane waarden — soft check, future-proof voor nieuwe bronnen.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.projects'::regclass
      AND conname  = 'projects_upload_source_check'
  ) THEN
    ALTER TABLE public.projects
      ADD CONSTRAINT projects_upload_source_check
      CHECK (upload_source IN ('manual', 'google_sheets', 'hubspot', 'aircall', 'lemlist'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.projects'::regclass
      AND conname  = 'projects_feedback_source_check'
  ) THEN
    ALTER TABLE public.projects
      ADD CONSTRAINT projects_feedback_source_check
      CHECK (feedback_source IN ('manual', 'google_sheets', 'hubspot'));
  END IF;
END $$;

COMMENT ON COLUMN public.projects.upload_source IS
  'Hoe leads/calls binnenkomen: manual (CSV upload) | google_sheets | hubspot | aircall | lemlist.';
COMMENT ON COLUMN public.projects.feedback_source IS
  'Hoe sales feedback (outcome) binnenkomt: manual (sales rep typt in app) | google_sheets (dealstage in sheet) | hubspot.';


-- 2. create_project RPC uitbreiden ─────────────────────────────────────────
-- Drop de oude signature en herzet met extra parameters.
DROP FUNCTION IF EXISTS public.create_project(text, text);

CREATE OR REPLACE FUNCTION public.create_project(
  p_name               text,
  p_description        text    DEFAULT NULL,
  p_upload_source      text    DEFAULT 'manual',
  p_feedback_source    text    DEFAULT 'manual',
  p_default_sales_rep_id uuid  DEFAULT NULL
)
RETURNS public.projects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id        uuid;
  v_call_center_id uuid;
  v_project        public.projects;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Authorisatie: alleen cc_managers mogen projecten aanmaken
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_user_id AND role = 'cc_manager'
  ) THEN
    RAISE EXCEPTION 'Only call center managers can create projects';
  END IF;

  -- Vind het call_center van de gebruiker
  SELECT id INTO v_call_center_id
  FROM public.call_centers
  WHERE manager_id = v_user_id
  LIMIT 1;

  IF v_call_center_id IS NULL THEN
    RAISE EXCEPTION 'No call center found — create one first';
  END IF;

  -- Atomaire insert van project + pcc-link
  INSERT INTO public.projects (
    name, description, upload_source, feedback_source, default_sales_rep_id
  )
  VALUES (
    p_name,
    p_description,
    COALESCE(p_upload_source,   'manual'),
    COALESCE(p_feedback_source, 'manual'),
    p_default_sales_rep_id
  )
  RETURNING * INTO v_project;

  INSERT INTO public.project_call_centers (project_id, call_center_id)
  VALUES (v_project.id, v_call_center_id);

  RETURN v_project;
END;
$$;

REVOKE ALL ON FUNCTION public.create_project(text, text, text, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.create_project(text, text, text, text, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS public.create_project(text, text, text, text, uuid);
-- ALTER TABLE public.projects
--   DROP CONSTRAINT IF EXISTS projects_upload_source_check,
--   DROP CONSTRAINT IF EXISTS projects_feedback_source_check,
--   DROP COLUMN     IF EXISTS upload_source,
--   DROP COLUMN     IF EXISTS feedback_source;
-- -- Re-create de oude create_project(text, text) signature uit 2026-04-29.
