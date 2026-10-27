-- Link Supabase Auth users to extension profiles and repair team access.
--
-- The extension now signs in directly with Supabase Auth and writes memories
-- with `auth.uid()` as the owner. Teams still use `extension_users` ids, so
-- every auth user needs a linked extension profile.

-- ============================================================
-- 1) Create an extension profile for every new auth user
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_extension_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.extension_users (name, migrated_to_auth_id)
  VALUES (
    COALESCE(
      NULLIF(NEW.raw_user_meta_data->>'display_name', ''),
      NULLIF(split_part(COALESCE(NEW.email, ''), '@', 1), ''),
      'User'
    ),
    NEW.id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_extension_profile ON auth.users;
CREATE TRIGGER on_auth_user_created_extension_profile
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_extension_user();

-- Backfill profiles for auth users created before this trigger existed.
INSERT INTO public.extension_users (name, migrated_to_auth_id)
SELECT
  COALESCE(
    NULLIF(p.display_name, ''),
    NULLIF(split_part(COALESCE(u.email, ''), '@', 1), ''),
    'User'
  ),
  u.id
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE NOT EXISTS (
  SELECT 1
  FROM public.extension_users eu
  WHERE eu.migrated_to_auth_id = u.id
);

-- ============================================================
-- 2) Let teammates resolve each other's display names
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_teammate_of_current_user(check_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.team_members teammate
      JOIN public.team_members mine ON mine.team_id = teammate.team_id
      WHERE teammate.user_id = check_user_id
        AND mine.user_id = public.current_extension_user_id()
    );
$$;

REVOKE EXECUTE ON FUNCTION public.is_teammate_of_current_user(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.is_teammate_of_current_user(uuid) TO authenticated;

DROP POLICY IF EXISTS "Team members read teammate profiles" ON public.extension_users;
CREATE POLICY "Team members read teammate profiles"
ON public.extension_users
FOR SELECT
TO authenticated
USING (
  migrated_to_auth_id = auth.uid()
  OR public.is_teammate_of_current_user(id)
);

-- ============================================================
-- 3) Team members can read all memories shared with the team
--    (the previous policy only allowed users who had already
--    shared a memory themselves)
-- ============================================================
DROP POLICY IF EXISTS "Team members can read team memories" ON public.memories;
CREATE POLICY "Team members can read team memories"
ON public.memories
FOR SELECT
TO authenticated
USING (
  auth.uid() = user_id
  OR (
    team_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.team_members tm
      WHERE tm.team_id = memories.team_id
        AND tm.user_id = public.current_extension_user_id()
    )
  )
);

-- ============================================================
-- 4) Team summaries are readable by every team member
-- ============================================================
DROP POLICY IF EXISTS "Auth team members read summaries" ON public.team_summaries;
CREATE POLICY "Auth team members read summaries"
ON public.team_summaries
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.team_members tm
    WHERE tm.team_id = team_summaries.team_id
      AND tm.user_id = public.current_extension_user_id()
  )
);

-- ============================================================
-- 5) Atomic invite-code join
--
-- `teams` is intentionally not readable by non-members, so the
-- extension cannot look a team up by invite code directly.
-- ============================================================
CREATE OR REPLACE FUNCTION public.join_team_by_invite(invite_code text)
RETURNS public.teams
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_team public.teams;
  extension_user_id uuid;
BEGIN
  extension_user_id := public.current_extension_user_id();

  IF extension_user_id IS NULL THEN
    RAISE EXCEPTION 'Your account profile is not ready yet';
  END IF;

  SELECT *
  INTO target_team
  FROM public.teams
  WHERE teams.invite_code = join_team_by_invite.invite_code
  LIMIT 1;

  IF target_team.id IS NULL THEN
    RAISE EXCEPTION 'Invalid invite code';
  END IF;

  INSERT INTO public.team_members (team_id, user_id)
  VALUES (target_team.id, extension_user_id)
  ON CONFLICT (team_id, user_id) DO NOTHING;

  RETURN target_team;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.join_team_by_invite(text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.join_team_by_invite(text) TO authenticated;

-- ============================================================
-- 6) Keep updated_at fresh for extension users created above
-- ============================================================
DROP TRIGGER IF EXISTS update_extension_users_updated_at ON public.extension_users;
CREATE TRIGGER update_extension_users_updated_at
BEFORE UPDATE ON public.extension_users
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();