-- Security follow-up: close legacy privileged RPCs and prevent future public execution.
revoke execute on function public.get_workspace_for_user(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.list_workspaces_for_user(uuid) from public, anon, authenticated;

alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
