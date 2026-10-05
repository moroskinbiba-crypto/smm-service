-- Expose workspace operations only through the authenticated Edge Function.
revoke all on function public.ensure_workspace_for_user(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.get_workspace_for_user(uuid) from public,anon,authenticated;
revoke all on function public.list_workspace_members_for_user(uuid) from public,anon,authenticated;
revoke all on function public.create_workspace_invite_for_user(uuid,integer) from public,anon,authenticated;
revoke all on function public.list_workspace_invites_for_user(uuid) from public,anon,authenticated;
revoke all on function public.revoke_workspace_invite_for_user(uuid,uuid) from public,anon,authenticated;
revoke all on function public.accept_workspace_invite_for_user(uuid,text) from public,anon,authenticated;

grant execute on function public.ensure_workspace_for_user(uuid,text,text,text) to service_role;
grant execute on function public.get_workspace_for_user(uuid) to service_role;
grant execute on function public.list_workspace_members_for_user(uuid) to service_role;
grant execute on function public.create_workspace_invite_for_user(uuid,integer) to service_role;
grant execute on function public.list_workspace_invites_for_user(uuid) to service_role;
grant execute on function public.revoke_workspace_invite_for_user(uuid,uuid) to service_role;
grant execute on function public.accept_workspace_invite_for_user(uuid,text) to service_role;

create policy workspace_invites_client_deny
on public.workspace_invites for all to authenticated
using(false)
with check(false);
