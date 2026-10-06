revoke execute on function public.ensure_personal_workspace_for_user(uuid,text) from public,anon,authenticated;
grant execute on function public.ensure_personal_workspace_for_user(uuid,text) to service_role;
create index if not exists account_groups_created_by_idx on public.account_groups (created_by);
