create or replace function public.accept_workspace_invite_for_user(p_user_id uuid, p_token text)
returns table(workspace_id uuid, workspace_name text, workspace_timezone text, role text)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_hash bytea;
  v_workspace_id uuid;
  v_workspace_name text;
  v_workspace_timezone text;
  v_role text;
  v_expires_at timestamptz;
  v_used_at timestamptz;
  v_current_workspace_id uuid;
  v_current_role text;
  v_current_owner_id uuid;
  v_member_count integer;
  v_posts_count integer;
  v_social_accounts_count integer;
  v_invites_count integer;
begin
  if p_user_id is null then raise exception 'User is required'; end if;

  v_hash := extensions.digest(trim(p_token), 'sha256');

  select wi.workspace_id, wi.role, wi.expires_at, wi.used_at
    into v_workspace_id, v_role, v_expires_at, v_used_at
  from public.workspace_invites wi
  where wi.token_hash = v_hash
  for update;

  if v_workspace_id is null then raise exception 'Invitation not found'; end if;
  if v_used_at is not null then raise exception 'Invitation has already been used'; end if;
  if v_expires_at <= now() then raise exception 'Invitation has expired'; end if;

  select wm.workspace_id, wm.role, w.owner_id
    into v_current_workspace_id, v_current_role, v_current_owner_id
  from public.workspace_members wm
  join public.workspaces w on w.id = wm.workspace_id
  where wm.user_id = p_user_id
  order by wm.created_at asc
  limit 1;

  if v_current_workspace_id is not null then
    if v_current_workspace_id = v_workspace_id then
      raise exception 'You are already a member of this workspace';
    end if;

    select count(*) into v_member_count from public.workspace_members wm2 where wm2.workspace_id = v_current_workspace_id;
    select count(*) into v_posts_count from public.posts p2 where p2.workspace_id = v_current_workspace_id;
    select count(*) into v_social_accounts_count from public.social_accounts sa2 where sa2.workspace_id = v_current_workspace_id;
    select count(*) into v_invites_count from public.workspace_invites wi2 where wi2.workspace_id = v_current_workspace_id;

    if v_current_role <> 'owner'
       or v_current_owner_id <> p_user_id
       or v_member_count <> 1
       or v_posts_count <> 0
       or v_social_accounts_count <> 0
       or v_invites_count <> 0 then
      raise exception 'User already belongs to a workspace';
    end if;

    update public.profiles
    set workspace_id = v_workspace_id, updated_at = now()
    where id = p_user_id;

    delete from public.workspace_members wm3
    where wm3.workspace_id = v_current_workspace_id
      and wm3.user_id = p_user_id;
  end if;

  select w.name, w.timezone
    into v_workspace_name, v_workspace_timezone
  from public.workspaces w
  where w.id = v_workspace_id;

  insert into public.workspace_members(workspace_id, user_id, role)
  values (v_workspace_id, p_user_id, v_role);

  insert into public.profiles(id, display_name, timezone, workspace_id)
  values (p_user_id, 'Пользователь', v_workspace_timezone, v_workspace_id)
  on conflict (id) do update set
    workspace_id = excluded.workspace_id,
    timezone = excluded.timezone,
    updated_at = now();

  update public.workspace_invites wi4
  set used_at = now(), used_by = p_user_id
  where wi4.token_hash = v_hash and wi4.used_at is null;

  return query select v_workspace_id, v_workspace_name, v_workspace_timezone, v_role;
end;
$function$;