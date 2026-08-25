-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: project_invites tabel + RLS + helper RPC's
-- Datum:    2026-04-30
-- Reden:    Cold callers, sales reps en sales managers krijgen geen self-
--           registration meer. Een cc_manager (of sales_manager) nodigt hen
--           uit per email vanuit de project-wizard of -settings:
--             - Bestaande profile (email gevonden) → directe project_member
--             - Nieuwe email → token-based invite, accept via /auth/accept-invite
--                              → account wordt aangemaakt met de vooraf-bepaalde rol
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.project_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  email        text NOT NULL,                                      -- altijd lowercase opslaan
  role         text NOT NULL,                                      -- 'cold_caller' | 'sales_rep' | 'sales_manager'
  token        text NOT NULL UNIQUE,                               -- random 32+ char string
  invited_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  expires_at   timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Eén pending invite per (project, email). Nieuwe invite voor zelfde combo
-- vervangt de oude (we doen DELETE + INSERT in /api/invites/send route).
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_invites_unique_pending
  ON public.project_invites (project_id, lower(email))
  WHERE accepted_at IS NULL;

-- Lookup-index op token voor snelle accept-flow
CREATE INDEX IF NOT EXISTS idx_project_invites_token
  ON public.project_invites (token)
  WHERE accepted_at IS NULL;

-- Role check
ALTER TABLE public.project_invites
  DROP CONSTRAINT IF EXISTS project_invites_role_check;
ALTER TABLE public.project_invites
  ADD CONSTRAINT project_invites_role_check
  CHECK (role IN ('cold_caller', 'sales_rep', 'sales_manager'));


-- ── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE public.project_invites ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.project_invites');

-- SELECT: managers van het project mogen pending invites zien
CREATE POLICY "invites_select_manager" ON public.project_invites
  FOR SELECT TO authenticated
  USING (
    public.is_cc_manager_of_project(project_id)
    OR EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = project_invites.project_id
        AND pm.profile_id = auth.uid()
        AND pm.role = 'sales_manager'
    )
  );

-- INSERT/UPDATE/DELETE gebeurt enkel via API routes (service_role) — geen
-- directe client-side mutations toelaten. We laten policies expliciet weg
-- zodat RLS alle non-service-role mutations blokkeert.


-- ── RPC: accept_invite_get_info ─────────────────────────────────────────
-- Publieke read-only RPC voor de accept-pagina: vraagt token op en geeft
-- project-naam + rol + uitnodigende manager terug. Voorkomt dat we de hele
-- project_invites tabel publiek moeten openzetten.
CREATE OR REPLACE FUNCTION public.get_invite_info(p_token text)
RETURNS TABLE (
  project_id    uuid,
  project_name  text,
  email         text,
  role          text,
  invited_by_name text,
  expires_at    timestamptz,
  expired       boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    pi.project_id,
    p.name           AS project_name,
    pi.email,
    pi.role,
    inviter.full_name AS invited_by_name,
    pi.expires_at,
    pi.expires_at < now() AS expired
  FROM public.project_invites pi
  JOIN public.projects p ON p.id = pi.project_id
  LEFT JOIN public.profiles inviter ON inviter.id = pi.invited_by
  WHERE pi.token = p_token
    AND pi.accepted_at IS NULL
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_invite_info(text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_invite_info(text) TO anon, authenticated;


-- ── RPC: complete_invite ────────────────────────────────────────────────
-- Wordt aangeroepen vanuit /api/invites/accept NADAT de auth.user is
-- aangemaakt via admin.createUser. Zet:
--   1. profile.role = invite.role (zodat eerste-rol gezet is)
--   2. project_members rij
--   3. invite.accepted_at = now()
--
-- Run als SECURITY DEFINER zodat de zojuist-aangemaakte user (die nog geen
-- RLS-toegang heeft tot project_members) deze rij kan laten aanmaken.
CREATE OR REPLACE FUNCTION public.complete_invite(
  p_token   text,
  p_user_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invite public.project_invites;
BEGIN
  SELECT * INTO v_invite
  FROM public.project_invites
  WHERE token = p_token AND accepted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Uitnodiging niet gevonden of al gebruikt' USING ERRCODE = '02000';
  END IF;
  IF v_invite.expires_at < now() THEN
    RAISE EXCEPTION 'Uitnodiging is verlopen' USING ERRCODE = '02000';
  END IF;

  -- Profile rol zetten (profile zelf wordt door auth-trigger of de API
  -- route al aangemaakt na admin.createUser).
  UPDATE public.profiles
  SET role = v_invite.role
  WHERE id = p_user_id;

  -- Voor cold_caller: ook in call_center_members van de inviter zodat
  -- RLS-helpers (has_project_access via call_center) werken.
  IF v_invite.role = 'cold_caller' THEN
    INSERT INTO public.call_center_members (call_center_id, profile_id)
    SELECT cc.id, p_user_id
    FROM public.call_centers cc
    JOIN public.project_call_centers pcc ON pcc.call_center_id = cc.id
    WHERE pcc.project_id = v_invite.project_id
    ON CONFLICT DO NOTHING;
  END IF;

  -- Project_members rij
  INSERT INTO public.project_members (project_id, profile_id, role)
  VALUES (v_invite.project_id, p_user_id, v_invite.role)
  ON CONFLICT DO NOTHING;

  -- Mark accepted
  UPDATE public.project_invites
  SET accepted_at = now()
  WHERE id = v_invite.id;
END $$;

REVOKE ALL ON FUNCTION public.complete_invite(text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.complete_invite(text, uuid) TO authenticated, service_role;


NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS public.complete_invite(text, uuid);
-- DROP FUNCTION IF EXISTS public.get_invite_info(text);
-- DROP TABLE IF EXISTS public.project_invites;
