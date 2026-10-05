-- Team/workspace bootstrap and invitation links.
-- UI roles for MVP: owner = руководитель, editor = сотрудник.

create unique index if not exists workspaces_owner_unique_idx
on public.workspaces(owner_id);

create table if not exists public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  token_hash bytea not null unique,
  role text not null default 'editor' check (role in ('editor')),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists workspace_invites_workspace_idx
on public.workspace_invites(workspace_id, created_at desc);
create index if not exists workspace_invites_active_idx
on public.workspace_invites(workspace_id, expires_at)
where used_at is null;

alter table public.workspace_invites enable row level security;

create or replace function public.user_has_workspace_role(p_workspace_id uuid, p_roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = auth.uid()
      and wm.role = any(p_roles)
  );
$$;
revoke all on function public.user_has_workspace_role(uuid,text[]) from public, anon;
grant execute on function public.user_has_workspace_role(uuid,text[]) to authenticated, service_role;

drop policy if exists workspace_invites_select_leaders on public.workspace_invites;
create policy workspace_invites_select_leaders on public.workspace_invites
for select to authenticated using (public.user_has_workspace_role(workspace_id, array['owner','admin']));

drop policy if exists workspace_invites_insert_leaders on public.workspace_invites;
create policy workspace_invites_insert_leaders on public.workspace_invites
for insert to authenticated with check (
  created_by = auth.uid()
  and public.user_has_workspace_role(workspace_id, array['owner','admin'])
);

drop policy if exists workspace_invites_update_leaders on public.workspace_invites;
create policy workspace_invites_update_leaders on public.workspace_invites
for update to authenticated using (public.user_has_workspace_role(workspace_id, array['owner','admin']))
with check (public.user_has_workspace_role(workspace_id, array['owner','admin']));

create or replace function public.ensure_workspace(
  p_name text default null, p_display_name text default null, p_timezone text default 'Europe/Moscow'
)
returns table(workspace_id uuid, workspace_name text, workspace_timezone text, role text)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_workspace_name text;
  v_display_name text;
  v_timezone text;
begin
  if v_user_id is null then raise exception 'Not authenticated'; end if;

  select p.workspace_id into v_workspace_id from public.profiles p where p.id = v_user_id;

  if v_workspace_id is null then
    v_workspace_name := nullif(trim(p_name), '');
    if v_workspace_name is null then v_workspace_name := 'Моя команда'; end if;
    v_timezone := coalesce(nullif(trim(p_timezone), ''), 'Europe/Moscow');

    insert into public.workspaces(name, owner_id, timezone)
    values (v_workspace_name, v_user_id, v_timezone)
    returning id into v_workspace_id;

    insert into public.workspace_members(workspace_id, user_id, role)
    values (v_workspace_id, v_user_id, 'owner')
    on conflict (workspace_id, user_id) do update set role='owner';

    v_display_name := nullif(trim(p_display_name), '');
    if v_display_name is null then
      v_display_name := nullif(split_part(coalesce(auth.jwt()->>'email', ''), '@', 1), '');
    end if;

    insert into public.profiles(id, display_name, timezone, workspace_id)
    values (v_user_id, coalesce(v_display_name, 'Пользователь'), v_timezone, v_workspace_id)
    on conflict (id) do update set
      workspace_id = excluded.workspace_id,
      timezone = coalesce(public.profiles.timezone, excluded.timezone),
      updated_at = now();
  else
    update public.profiles
    set workspace_id = v_workspace_id,
        display_name = coalesce(nullif(trim(p_display_name), ''), public.profiles.display_name),
        updated_at = now()
    where id = v_user_id;

    insert into public.workspace_members(workspace_id, user_id, role)
    values (v_workspace_id, v_user_id, 'owner')
    on conflict (workspace_id, user_id) do nothing;
  end if;

  return query
  select w.id, w.name, w.timezone, wm.role
  from public.workspaces w
  join public.workspace_members wm on wm.workspace_id = w.id and wm.user_id = v_user_id
  where w.id = v_workspace_id;
end;
$$;
revoke all on function public.ensure_workspace(text,text,text) from public, anon;
grant execute on function public.ensure_workspace(text,text,text) to authenticated, service_role;

create or replace function public.get_my_workspace()
returns table(workspace_id uuid, workspace_name text, workspace_timezone text, role text)
language sql stable security definer set search_path = public as $$
  select w.id, w.name, w.timezone, wm.role
  from public.workspace_members wm join public.workspaces w on w.id = wm.workspace_id
  where wm.user_id = auth.uid()
  order by wm.created_at asc limit 1;
$$;
revoke all on function public.get_my_workspace() from public, anon;
grant execute on function public.get_my_workspace() to authenticated, service_role;

create or replace function public.list_workspace_members()
returns table(user_id uuid, display_name text, role text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select wm.user_id, p.display_name, wm.role, wm.created_at
  from public.workspace_members wm
  left join public.profiles p on p.id = wm.user_id
  join public.workspace_members me on me.workspace_id = wm.workspace_id and me.user_id = auth.uid()
  where wm.workspace_id = me.workspace_id
  order by case when wm.role = 'owner' then 0 else 1 end, wm.created_at asc;
$$;
revoke all on function public.list_workspace_members() from public, anon;
grant execute on function public.list_workspace_members() to authenticated, service_role;

create or replace function public.create_workspace_invite(p_expires_in_hours integer default 168)
returns table(invite_id uuid, token text, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_invite_id uuid;
  v_token text;
  v_expires_at timestamptz;
begin
  if v_user_id is null then raise exception 'Not authenticated'; end if;

  select wm.workspace_id into v_workspace_id
  from public.workspace_members wm
  where wm.user_id = v_user_id and wm.role in ('owner','admin')
  order by wm.created_at asc limit 1;

  if v_workspace_id is null then raise exception 'Only a руководитель can create invitations'; end if;
  if p_expires_in_hours < 1 or p_expires_in_hours > 720 then raise exception 'Invalid invitation lifetime'; end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  v_expires_at := now() + make_interval(hours => p_expires_in_hours);

  insert into public.workspace_invites(workspace_id, created_by, token_hash, role, expires_at)
  values (v_workspace_id, v_user_id, extensions.digest(v_token, 'sha256'), 'editor', v_expires_at)
  returning id into v_invite_id;

  return query select v_invite_id, v_token, v_expires_at;
end;
$$;
revoke all on function public.create_workspace_invite(integer) from public, anon;
grant execute on function public.create_workspace_invite(integer) to authenticated, service_role;

create or replace function public.revoke_workspace_invite(p_invite_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_workspace_id uuid;
begin
  select wi.workspace_id into v_workspace_id from public.workspace_invites wi where wi.id = p_invite_id;
  if v_workspace_id is null or not public.user_has_workspace_role(v_workspace_id, array['owner','admin']) then raise exception 'Not allowed'; end if;
  update public.workspace_invites set used_at = coalesce(used_at, now()) where id = p_invite_id;
  return found;
end;
$$;
revoke all on function public.revoke_workspace_invite(uuid) from public, anon;
grant execute on function public.revoke_workspace_invite(uuid) to authenticated, service_role;

create or replace function public.list_workspace_invites()
returns table(invite_id uuid, expires_at timestamptz, used_at timestamptz, created_at timestamptz, role text)
language sql stable security definer set search_path = public as $$
  select wi.id, wi.expires_at, wi.used_at, wi.created_at, wi.role
  from public.workspace_invites wi
  where public.user_has_workspace_role(wi.workspace_id, array['owner','admin'])
  order by wi.created_at desc;
$$;
revoke all on function public.list_workspace_invites() from public, anon;
grant execute on function public.list_workspace_invites() to authenticated, service_role;

create or replace function public.accept_workspace_invite(p_token text)
returns table(workspace_id uuid, workspace_name text, workspace_timezone text, role text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user_id uuid := auth.uid();
  v_hash bytea;
  v_workspace_id uuid;
  v_role text;
  v_expires_at timestamptz;
  v_used_at timestamptz;
begin
  if v_user_id is null then raise exception 'Not authenticated'; end if;
  if nullif(trim(p_token), '') is null then raise exception 'Invitation token is required'; end if;

  if exists (select 1 from public.workspace_members wm where wm.user_id = v_user_id) then
    raise exception 'User already belongs to a workspace';
  end if;

  v_hash := extensions.digest(trim(p_token), 'sha256');

  select wi.workspace_id, wi.role, wi.expires_at, wi.used_at into v_workspace_id, v_role, v_expires_at, v_used_at
  from public.workspace_invites wi where wi.token_hash = v_hash for update;

  if v_workspace_id is null then raise exception 'Invitation not found'; end if;
  if v_used_at is not null then raise exception 'Invitation has already been used'; end if;
  if v_expires_at <= now() then raise exception 'Invitation has expired'; end if;

  insert into public.workspace_members(workspace_id, user_id, role) values (v_workspace_id, v_user_id, v_role);

  insert into public.profiles(id, display_name, timezone, workspace_id)
  values (
    v_user_id,
    coalesce(nullif(split_part(coalesce(auth.jwt()->>'email', ''), '@', 1), ''), 'Пользователь'),
    (select w.timezone from public.workspaces w where w.id = v_workspace_id),
    v_workspace_id
  )
  on conflict (id) do update set workspace_id = excluded.workspace_id, timezone = excluded.timezone, updated_at = now();

  update public.workspace_invites
  set used_at = now(), used_by = v_user_id
  where token_hash = v_hash and used_at is null;

  return query select w.id, w.name, w.timezone, v_role from public.workspaces w where w.id = v_workspace_id;
end;
$$;
revoke all on function public.accept_workspace_invite(text) from public, anon;
grant execute on function public.accept_workspace_invite(text) to authenticated, service_role;
