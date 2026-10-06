
alter table public.workspaces
  add column if not exists workspace_kind text not null default 'personal',
  add column if not exists max_members integer not null default 1;

update public.workspaces
set workspace_kind = case when exists (
  select 1 from public.workspace_members wm
  where wm.workspace_id = workspaces.id
  group by wm.workspace_id
  having count(*) > 1
) then 'team' else 'personal' end,
max_members = case when exists (
  select 1 from public.workspace_members wm
  where wm.workspace_id = workspaces.id
  group by wm.workspace_id
  having count(*) > 1
) then greatest(max_members, 10) else 1 end;

alter table public.workspaces
  drop constraint if exists workspaces_workspace_kind_check,
  drop constraint if exists workspaces_max_members_check;

alter table public.workspaces
  add constraint workspaces_workspace_kind_check check (workspace_kind in ('personal','team')),
  add constraint workspaces_max_members_check check (max_members between 1 and 10000);

create index if not exists workspaces_kind_idx on public.workspaces (workspace_kind);
create index if not exists workspace_members_user_created_idx on public.workspace_members (user_id, created_at);

create table if not exists public.account_groups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  description text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_groups_name_not_empty check (length(btrim(name)) > 0),
  constraint account_groups_name_unique unique (workspace_id, name)
);

create table if not exists public.account_group_members (
  group_id uuid not null references public.account_groups(id) on delete cascade,
  social_account_id uuid not null references public.social_accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, social_account_id)
);

alter table public.account_groups enable row level security;
alter table public.account_group_members enable row level security;

create index if not exists account_groups_workspace_idx on public.account_groups (workspace_id);
create index if not exists account_group_members_account_idx on public.account_group_members (social_account_id);

drop policy if exists account_groups_workspace_select on public.account_groups;
drop policy if exists account_group_members_workspace_select on public.account_group_members;

create policy account_groups_workspace_select
  on public.account_groups for select to authenticated
  using (exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = account_groups.workspace_id
      and wm.user_id = (select auth.uid())
  ));

create policy account_group_members_workspace_select
  on public.account_group_members for select to authenticated
  using (exists (
    select 1 from public.account_groups ag
    join public.workspace_members wm on wm.workspace_id = ag.workspace_id
    where ag.id = account_group_members.group_id
      and wm.user_id = (select auth.uid())
  ));

create or replace function public.ensure_personal_workspace_for_user(p_user_id uuid, p_timezone text default 'Europe/Moscow')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace_id uuid;
  v_name text;
  v_timezone text;
begin
  select w.id into v_workspace_id
  from public.workspaces w
  where w.owner_id = p_user_id
    and w.workspace_kind = 'personal'
  order by w.created_at asc
  limit 1;

  if v_workspace_id is not null then
    return v_workspace_id;
  end if;

  select coalesce(nullif(u.email,''),'Личный профиль')
    into v_name
  from auth.users u
  where u.id = p_user_id;

  v_name := coalesce(v_name, 'Личный профиль');
  v_timezone := coalesce(nullif(trim(p_timezone),''),'Europe/Moscow');

  insert into public.workspaces(name, owner_id, timezone, workspace_kind, max_members)
  values ('Личный · ' || v_name, p_user_id, v_timezone, 'personal', 1)
  returning id into v_workspace_id;

  insert into public.workspace_members(workspace_id, user_id, role)
  values (v_workspace_id, p_user_id, 'owner')
  on conflict (workspace_id, user_id) do nothing;

  update public.profiles
  set workspace_id = coalesce(workspace_id, v_workspace_id),
      updated_at = now()
  where id = p_user_id;

  return v_workspace_id;
end;
$$;

create or replace function public.ensure_workspace_for_user(
  p_user_id uuid,
  p_name text default null,
  p_display_name text default null,
  p_timezone text default 'Europe/Moscow'
)
returns table(workspace_id uuid, workspace_name text, workspace_timezone text, role text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace_id uuid;
  v_display_name text;
  v_timezone text;
begin
  if p_user_id is null then raise exception 'User is required'; end if;

  select p.workspace_id into v_workspace_id from public.profiles p where p.id = p_user_id;

  if v_workspace_id is null then
    v_workspace_id := public.ensure_personal_workspace_for_user(p_user_id, p_timezone);
  else
    if not exists (
      select 1 from public.workspace_members wm where wm.workspace_id = v_workspace_id and wm.user_id = p_user_id
    ) then
      v_workspace_id := public.ensure_personal_workspace_for_user(p_user_id, p_timezone);
    end if;
  end if;

  v_display_name := nullif(trim(p_display_name), '');
  if v_display_name is not null then
    update public.profiles set display_name = v_display_name, updated_at = now() where id = p_user_id;
  end if;

  return query
  select w.id, w.name, w.timezone, wm.role
  from public.workspaces w
  join public.workspace_members wm on wm.workspace_id = w.id and wm.user_id = p_user_id
  where w.id = v_workspace_id;
end;
$$;

create or replace function public.get_workspace_for_user(p_user_id uuid, p_workspace_id uuid default null)
returns table(workspace_id uuid, workspace_name text, workspace_timezone text, role text, workspace_kind text, max_members integer, member_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select w.id, w.name, w.timezone, wm.role, w.workspace_kind, w.max_members,
         (select count(*) from public.workspace_members m2 where m2.workspace_id = w.id)
  from public.workspace_members wm
  join public.workspaces w on w.id = wm.workspace_id
  where wm.user_id = p_user_id
    and (p_workspace_id is null or w.id = p_workspace_id)
  order by case when w.workspace_kind = 'personal' then 0 else 1 end, wm.created_at asc
  limit 1;
$$;

create or replace function public.list_workspaces_for_user(p_user_id uuid)
returns table(workspace_id uuid, workspace_name text, workspace_timezone text, role text, workspace_kind text, max_members integer, member_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select w.id, w.name, w.timezone, wm.role, w.workspace_kind, w.max_members,
         (select count(*) from public.workspace_members m2 where m2.workspace_id = w.id)
  from public.workspace_members wm
  join public.workspaces w on w.id = wm.workspace_id
  where wm.user_id = p_user_id
  order by case when w.workspace_kind = 'personal' then 0 else 1 end, w.created_at asc;
$$;

create or replace function public.list_workspace_members_for_user(p_user_id uuid, p_workspace_id uuid default null)
returns table(user_id uuid, display_name text, role text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select wm.user_id, p.display_name, wm.role, wm.created_at
  from public.workspace_members wm
  left join public.profiles p on p.id = wm.user_id
  where wm.workspace_id = (
    select x.workspace_id from public.get_workspace_for_user(p_user_id, p_workspace_id) x limit 1
  )
  order by case when wm.role = 'owner' then 0 else 1 end, wm.created_at asc;
$$;

create or replace function public.list_workspace_invites_for_user(p_user_id uuid, p_workspace_id uuid default null)
returns table(invite_id uuid, expires_at timestamptz, used_at timestamptz, created_at timestamptz, role text)
language sql
stable
security definer
set search_path = public
as $$
  select wi.id, wi.expires_at, wi.used_at, wi.created_at, wi.role
  from public.workspace_invites wi
  where wi.workspace_id = (
    select x.workspace_id from public.get_workspace_for_user(p_user_id, p_workspace_id) x limit 1
  )
  order by wi.created_at desc;
$$;

create or replace function public.revoke_workspace_invite_for_user(p_user_id uuid, p_invite_id uuid, p_workspace_id uuid default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace_id uuid;
  v_role text;
begin
  select x.workspace_id, x.role into v_workspace_id, v_role
  from public.get_workspace_for_user(p_user_id, p_workspace_id) x
  limit 1;

  if v_workspace_id is null or v_role not in ('owner','admin') then
    raise exception 'Not allowed';
  end if;

  update public.workspace_invites
  set used_at = coalesce(used_at, now())
  where id = p_invite_id and workspace_id = v_workspace_id;

  return found;
end;
$$;

create or replace function public.create_workspace_invite_for_user(
  p_user_id uuid,
  p_expires_in_hours integer default 168,
  p_workspace_id uuid default null,
  p_role text default 'editor'
)
returns table(invite_id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_workspace_id uuid;
  v_actor_role text;
  v_workspace_kind text;
  v_max_members integer;
  v_member_count integer;
  v_pending_invites integer;
  v_token text;
  v_invite_id uuid;
  v_expires_at timestamptz;
begin
  select x.workspace_id, x.role, x.workspace_kind, x.max_members
    into v_workspace_id, v_actor_role, v_workspace_kind, v_max_members
  from public.get_workspace_for_user(p_user_id, p_workspace_id) x
  limit 1;

  if v_workspace_id is null or v_actor_role not in ('owner','admin') then
    raise exception 'Only a руководитель can create invitations';
  end if;

  if p_expires_in_hours < 1 or p_expires_in_hours > 720 then
    raise exception 'Invalid invitation lifetime';
  end if;

  if p_role not in ('editor','publisher','approver','viewer','admin') then
    raise exception 'Invalid invitation role';
  end if;

  if v_workspace_kind = 'personal' then
    update public.workspaces
    set workspace_kind = 'team',
        max_members = greatest(max_members, 10),
        updated_at = now()
    where id = v_workspace_id;

    perform public.ensure_personal_workspace_for_user(p_user_id);

    v_workspace_kind := 'team';
    v_max_members := greatest(v_max_members, 10);
  end if;

  select count(*) into v_member_count
  from public.workspace_members
  where workspace_id = v_workspace_id;

  select count(*) into v_pending_invites
  from public.workspace_invites
  where workspace_id = v_workspace_id
    and used_at is null
    and expires_at > now();

  if v_member_count + v_pending_invites >= v_max_members then
    raise exception 'Лимит участников команды достигнут';
  end if;

  if p_role = 'admin' and v_actor_role <> 'owner' then
    raise exception 'Только владелец может приглашать администраторов';
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  v_expires_at := now() + make_interval(hours => p_expires_in_hours);

  insert into public.workspace_invites(workspace_id, created_by, token_hash, role, expires_at)
  values (v_workspace_id, p_user_id, extensions.digest(v_token, 'sha256'), p_role, v_expires_at)
  returning id into v_invite_id;

  return query select v_invite_id, v_token, v_expires_at;
end;
$$;

create or replace function public.accept_workspace_invite_for_user(p_user_id uuid, p_token text)
returns table(workspace_id uuid, workspace_name text, workspace_timezone text, role text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash bytea;
  v_workspace_id uuid;
  v_workspace_name text;
  v_workspace_timezone text;
  v_role text;
  v_inviter uuid;
  v_expires_at timestamptz;
  v_used_at timestamptz;
  v_max_members integer;
  v_member_count integer;
  v_personal_workspace_id uuid;
begin
  if p_user_id is null then raise exception 'User is required'; end if;
  v_hash := extensions.digest(trim(p_token), 'sha256');

  select wi.workspace_id, wi.role, wi.created_by, wi.expires_at, wi.used_at
    into v_workspace_id, v_role, v_inviter, v_expires_at, v_used_at
  from public.workspace_invites wi
  where wi.token_hash = v_hash
  for update;

  if v_workspace_id is null then raise exception 'Invitation not found'; end if;
  if v_used_at is not null then raise exception 'Invitation has already been used'; end if;
  if v_expires_at <= now() then raise exception 'Invitation has expired'; end if;

  select count(*) into v_member_count from public.workspace_members where workspace_id = v_workspace_id;
  select max_members into v_max_members from public.workspaces where id = v_workspace_id;

  if v_member_count >= coalesce(v_max_members, 10) then
    raise exception 'Лимит участников команды достигнут';
  end if;

  if exists(select 1 from public.workspace_members where workspace_id = v_workspace_id and user_id = p_user_id) then
    raise exception 'You are already a member of this workspace';
  end if;

  v_personal_workspace_id := public.ensure_personal_workspace_for_user(p_user_id);

  select w.name, w.timezone into v_workspace_name, v_workspace_timezone
  from public.workspaces w
  where w.id = v_workspace_id;

  insert into public.workspace_members(workspace_id,user_id,role,invited_by)
  values(v_workspace_id,p_user_id,v_role,v_inviter);

  insert into public.profiles(id,workspace_id,timezone)
  values(p_user_id,v_personal_workspace_id,v_workspace_timezone)
  on conflict(id) do update set workspace_id=coalesce(public.profiles.workspace_id,excluded.workspace_id), updated_at=now();

  update public.workspace_invites
  set used_at=now(),used_by=p_user_id
  where token_hash=v_hash and used_at is null;

  return query select v_workspace_id,v_workspace_name,v_workspace_timezone,v_role;
end;
$$;

revoke execute on function public.get_workspace_for_user(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_workspace_for_user(uuid,uuid) to service_role;

revoke execute on function public.list_workspaces_for_user(uuid) from public,anon,authenticated;
grant execute on function public.list_workspaces_for_user(uuid) to service_role;

revoke execute on function public.list_workspace_members_for_user(uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_workspace_members_for_user(uuid,uuid) to service_role;

revoke execute on function public.list_workspace_invites_for_user(uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_workspace_invites_for_user(uuid,uuid) to service_role;

revoke execute on function public.revoke_workspace_invite_for_user(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.revoke_workspace_invite_for_user(uuid,uuid,uuid) to service_role;

revoke execute on function public.create_workspace_invite_for_user(uuid,integer,uuid,text) from public,anon,authenticated;
grant execute on function public.create_workspace_invite_for_user(uuid,integer,uuid,text) to service_role;

revoke execute on function public.accept_workspace_invite_for_user(uuid,text) from public,anon,authenticated;
grant execute on function public.accept_workspace_invite_for_user(uuid,text) to service_role;

create or replace function public.remove_workspace_member_for_user(
  p_actor_id uuid,
  p_target_id uuid,
  p_workspace_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace_id uuid;
  v_actor_role text;
  v_target_role text;
begin
  select x.workspace_id,x.role into v_workspace_id,v_actor_role
  from public.get_workspace_for_user(p_actor_id,p_workspace_id) x limit 1;

  if v_workspace_id is null or v_actor_role not in ('owner','admin') then
    raise exception 'Недостаточно прав';
  end if;
  if p_actor_id = p_target_id then raise exception 'Нельзя удалить себя из команды'; end if;

  select role into v_target_role
  from public.workspace_members
  where workspace_id=v_workspace_id and user_id=p_target_id;

  if v_target_role is null then raise exception 'Участник не найден'; end if;
  if v_target_role='owner' then raise exception 'Владельца нельзя удалить из команды'; end if;
  if v_actor_role='admin' and v_target_role='admin' then
    raise exception 'Администратор не может удалить другого администратора';
  end if;

  delete from public.workspace_members
  where workspace_id=v_workspace_id and user_id=p_target_id;

  return found;
end;
$$;

revoke execute on function public.remove_workspace_member_for_user(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.remove_workspace_member_for_user(uuid,uuid,uuid) to service_role;

create or replace function public.admin_set_workspace_limit(
  p_workspace_id uuid,
  p_max_members integer
)
returns table(workspace_id uuid,max_members integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_max_members < 1 or p_max_members > 10000 then
    raise exception 'Лимит должен быть от 1 до 10000';
  end if;
  update public.workspaces
  set max_members = greatest(p_max_members, (
    select count(*) from public.workspace_members wm where wm.workspace_id = workspaces.id
  )::integer),
      workspace_kind = case when workspace_kind='personal' and p_max_members > 1 then 'team' else workspace_kind end,
      updated_at = now()
  where id=p_workspace_id;

  if not found then raise exception 'Рабочее пространство не найдено'; end if;
  return query select id,max_members from public.workspaces where id=p_workspace_id;
end;
$$;

revoke execute on function public.admin_set_workspace_limit(uuid,integer) from public,anon,authenticated;
grant execute on function public.admin_set_workspace_limit(uuid,integer) to service_role;
