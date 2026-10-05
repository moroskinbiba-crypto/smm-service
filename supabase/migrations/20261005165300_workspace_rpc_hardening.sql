-- Workspace client access is routed through the authenticated Edge Function.
create or replace function public.ensure_workspace_for_user(
  p_user_id uuid,
  p_name text default null,
  p_display_name text default null,
  p_timezone text default 'Europe/Moscow'
)
returns table(workspace_id uuid, workspace_name text, workspace_timezone text, role text)
language plpgsql security definer set search_path = public as $$
declare
  v_workspace_id uuid;
  v_workspace_name text;
  v_display_name text;
  v_timezone text;
begin
  if p_user_id is null then raise exception 'User is required'; end if;
  select p.workspace_id into v_workspace_id from public.profiles p where p.id = p_user_id;
  if v_workspace_id is null then
    v_workspace_name := coalesce(nullif(trim(p_name), ''), 'Моя команда');
    v_timezone := coalesce(nullif(trim(p_timezone), ''), 'Europe/Moscow');
    begin
      insert into public.workspaces(name, owner_id, timezone)
      values (v_workspace_name, p_user_id, v_timezone)
      returning id into v_workspace_id;
    exception when unique_violation then
      select w.id into v_workspace_id from public.workspaces w where w.owner_id = p_user_id;
    end;
    insert into public.workspace_members(workspace_id, user_id, role)
    values (v_workspace_id, p_user_id, 'owner')
    on conflict (workspace_id, user_id) do update set role='owner';
    v_display_name := coalesce(nullif(trim(p_display_name), ''), 'Пользователь');
    insert into public.profiles(id, display_name, timezone, workspace_id)
    values (p_user_id, v_display_name, v_timezone, v_workspace_id)
    on conflict (id) do update set workspace_id=excluded.workspace_id, timezone=coalesce(public.profiles.timezone, excluded.timezone), updated_at=now();
  end if;
  return query
  select w.id, w.name, w.timezone, wm.role
  from public.workspaces w join public.workspace_members wm on wm.workspace_id=w.id and wm.user_id=p_user_id
  where w.id=v_workspace_id;
end;
$$;

create or replace function public.get_workspace_for_user(p_user_id uuid)
returns table(workspace_id uuid, workspace_name text, workspace_timezone text, role text)
language sql stable security definer set search_path=public as $$
  select w.id,w.name,w.timezone,wm.role from public.workspace_members wm
  join public.workspaces w on w.id=wm.workspace_id
  where wm.user_id=p_user_id order by wm.created_at asc limit 1;
$$;

create or replace function public.list_workspace_members_for_user(p_user_id uuid)
returns table(user_id uuid, display_name text, role text, created_at timestamptz)
language sql stable security definer set search_path=public as $$
  select wm.user_id,p.display_name,wm.role,wm.created_at
  from public.workspace_members wm left join public.profiles p on p.id=wm.user_id
  where wm.workspace_id=(select wm2.workspace_id from public.workspace_members wm2 where wm2.user_id=p_user_id order by wm2.created_at asc limit 1)
  order by case when wm.role='owner' then 0 else 1 end,wm.created_at asc;
$$;

create or replace function public.create_workspace_invite_for_user(p_user_id uuid,p_expires_in_hours integer default 168)
returns table(invite_id uuid,token text,expires_at timestamptz)
language plpgsql security definer set search_path=public,extensions as $$
declare v_workspace_id uuid; v_role text; v_invite_id uuid; v_token text; v_expires_at timestamptz;
begin
  select wm.workspace_id,wm.role into v_workspace_id,v_role from public.workspace_members wm where wm.user_id=p_user_id order by wm.created_at asc limit 1;
  if v_workspace_id is null or v_role not in ('owner','admin') then raise exception 'Only a руководитель can create invitations'; end if;
  if p_expires_in_hours<1 or p_expires_in_hours>720 then raise exception 'Invalid invitation lifetime'; end if;
  v_token:=encode(gen_random_bytes(32),'hex'); v_expires_at:=now()+make_interval(hours=>p_expires_in_hours);
  insert into public.workspace_invites(workspace_id,created_by,token_hash,role,expires_at)
  values(v_workspace_id,p_user_id,extensions.digest(v_token,'sha256'),'editor',v_expires_at)
  returning id into v_invite_id;
  return query select v_invite_id,v_token,v_expires_at;
end;
$$;

create or replace function public.list_workspace_invites_for_user(p_user_id uuid)
returns table(invite_id uuid,expires_at timestamptz,used_at timestamptz,created_at timestamptz,role text)
language sql stable security definer set search_path=public as $$
  select wi.id,wi.expires_at,wi.used_at,wi.created_at,wi.role from public.workspace_invites wi
  where wi.workspace_id=(select wm.workspace_id from public.workspace_members wm where wm.user_id=p_user_id order by wm.created_at asc limit 1)
  order by wi.created_at desc;
$$;

create or replace function public.revoke_workspace_invite_for_user(p_user_id uuid,p_invite_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_workspace_id uuid; v_role text;
begin
  select wm.workspace_id,wm.role into v_workspace_id,v_role from public.workspace_members wm where wm.user_id=p_user_id order by wm.created_at asc limit 1;
  if v_workspace_id is null or v_role not in ('owner','admin') then raise exception 'Not allowed'; end if;
  update public.workspace_invites set used_at=coalesce(used_at,now()) where id=p_invite_id and workspace_id=v_workspace_id;
  return found;
end;
$$;

create or replace function public.accept_workspace_invite_for_user(p_user_id uuid,p_token text)
returns table(workspace_id uuid,workspace_name text,workspace_timezone text,role text)
language plpgsql security definer set search_path=public,extensions as $$
declare v_hash bytea; v_workspace_id uuid; v_workspace_name text; v_workspace_timezone text; v_role text; v_expires_at timestamptz; v_used_at timestamptz;
begin
  if exists(select 1 from public.workspace_members wm where wm.user_id=p_user_id) then raise exception 'User already belongs to a workspace'; end if;
  if nullif(trim(p_token),'') is null then raise exception 'Invitation token is required'; end if;
  v_hash:=extensions.digest(trim(p_token),'sha256');
  select wi.workspace_id,wi.role,wi.expires_at,wi.used_at into v_workspace_id,v_role,v_expires_at,v_used_at
  from public.workspace_invites wi where wi.token_hash=v_hash for update;
  if v_workspace_id is null then raise exception 'Invitation not found'; end if;
  if v_used_at is not null then raise exception 'Invitation has already been used'; end if;
  if v_expires_at<=now() then raise exception 'Invitation has expired'; end if;
  select w.name,w.timezone into v_workspace_name,v_workspace_timezone from public.workspaces w where w.id=v_workspace_id;
  insert into public.workspace_members(workspace_id,user_id,role) values(v_workspace_id,p_user_id,v_role);
  insert into public.profiles(id,display_name,timezone,workspace_id) values(p_user_id,'Пользователь',v_workspace_timezone,v_workspace_id)
  on conflict(id) do update set workspace_id=excluded.workspace_id,timezone=excluded.timezone,updated_at=now();
  update public.workspace_invites set used_at=now(),used_by=p_user_id where token_hash=v_hash and used_at is null;
  return query select v_workspace_id,v_workspace_name,v_workspace_timezone,v_role;
end;
$$;

revoke execute on function public.user_has_workspace_role(uuid,text[]) from authenticated,anon,public;
revoke execute on function public.ensure_workspace(text,text,text) from authenticated,anon,public;
revoke execute on function public.get_my_workspace() from authenticated,anon,public;
revoke execute on function public.list_workspace_members() from authenticated,anon,public;
revoke execute on function public.create_workspace_invite(integer) from authenticated,anon,public;
revoke execute on function public.revoke_workspace_invite(uuid) from authenticated,anon,public;
revoke execute on function public.list_workspace_invites() from authenticated,anon,public;
revoke execute on function public.accept_workspace_invite(text) from authenticated,anon,public;

revoke all on table public.workspace_invites from authenticated,anon,public;
create index if not exists workspace_invites_created_by_idx on public.workspace_invites(created_by);
create index if not exists workspace_invites_used_by_idx on public.workspace_invites(used_by);
