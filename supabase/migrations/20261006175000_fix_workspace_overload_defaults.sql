drop function if exists public.create_workspace_invite_for_user(uuid,integer,uuid,text);
drop function if exists public.revoke_workspace_invite_for_user(uuid,uuid,uuid);
drop function if exists public.list_workspace_invites_for_user(uuid,uuid);
drop function if exists public.list_workspace_members_for_user(uuid,uuid);
drop function if exists public.get_workspace_for_user(uuid,uuid);

create function public.get_workspace_for_user(p_user_id uuid, p_workspace_id uuid)
returns table(workspace_id uuid, workspace_name text, workspace_timezone text, role text, workspace_kind text, max_members integer, member_count bigint)
language sql stable security definer set search_path=public
as $$
  select w.id,w.name,w.timezone,wm.role,w.workspace_kind,w.max_members,
         (select count(*) from public.workspace_members m2 where m2.workspace_id=w.id)
  from public.workspace_members wm
  join public.workspaces w on w.id=wm.workspace_id
  where wm.user_id=p_user_id and (p_workspace_id is null or w.id=p_workspace_id)
  order by case when w.workspace_kind='personal' then 0 else 1 end,wm.created_at asc
  limit 1;
$$;

create function public.list_workspace_members_for_user(p_user_id uuid,p_workspace_id uuid)
returns table(user_id uuid,display_name text,role text,created_at timestamptz)
language sql stable security definer set search_path=public
as $$
  select wm.user_id,p.display_name,wm.role,wm.created_at
  from public.workspace_members wm left join public.profiles p on p.id=wm.user_id
  where wm.workspace_id=(select x.workspace_id from public.get_workspace_for_user(p_user_id,p_workspace_id) x limit 1)
  order by case when wm.role='owner' then 0 else 1 end,wm.created_at asc;
$$;

create function public.list_workspace_invites_for_user(p_user_id uuid,p_workspace_id uuid)
returns table(invite_id uuid,expires_at timestamptz,used_at timestamptz,created_at timestamptz,role text)
language sql stable security definer set search_path=public
as $$
  select wi.id,wi.expires_at,wi.used_at,wi.created_at,wi.role
  from public.workspace_invites wi
  where wi.workspace_id=(select x.workspace_id from public.get_workspace_for_user(p_user_id,p_workspace_id) x limit 1)
  order by wi.created_at desc;
$$;

create function public.revoke_workspace_invite_for_user(p_user_id uuid,p_invite_id uuid,p_workspace_id uuid)
returns boolean
language plpgsql security definer set search_path=public
as $$
declare v_workspace_id uuid; v_role text;
begin
  select x.workspace_id,x.role into v_workspace_id,v_role
  from public.get_workspace_for_user(p_user_id,p_workspace_id) x limit 1;
  if v_workspace_id is null or v_role not in ('owner','admin') then raise exception 'Not allowed'; end if;
  update public.workspace_invites set used_at=coalesce(used_at,now())
  where id=p_invite_id and workspace_id=v_workspace_id;
  return found;
end;
$$;

create function public.create_workspace_invite_for_user(p_user_id uuid,p_expires_in_hours integer,p_workspace_id uuid,p_role text)
returns table(invite_id uuid,token text,expires_at timestamptz)
language plpgsql security definer set search_path=public,extensions
as $$
declare
 v_workspace_id uuid; v_actor_role text; v_workspace_kind text; v_max_members integer;
 v_member_count integer; v_pending_invites integer; v_token text; v_invite_id uuid; v_expires_at timestamptz;
begin
 select x.workspace_id,x.role,x.workspace_kind,x.max_members into v_workspace_id,v_actor_role,v_workspace_kind,v_max_members
 from public.get_workspace_for_user(p_user_id,p_workspace_id) x limit 1;
 if v_workspace_id is null or v_actor_role not in ('owner','admin') then raise exception 'Only a руководитель can create invitations'; end if;
 if p_expires_in_hours<1 or p_expires_in_hours>720 then raise exception 'Invalid invitation lifetime'; end if;
 if p_role not in ('editor','publisher','approver','viewer','admin') then raise exception 'Invalid invitation role'; end if;
 if v_workspace_kind='personal' then
   update public.workspaces set workspace_kind='team',max_members=greatest(max_members,10),updated_at=now() where id=v_workspace_id;
   perform public.ensure_personal_workspace_for_user(p_user_id);
   v_max_members=greatest(v_max_members,10);
 end if;
 select count(*) into v_member_count from public.workspace_members where workspace_id=v_workspace_id;
 select count(*) into v_pending_invites from public.workspace_invites where workspace_id=v_workspace_id and used_at is null and expires_at>now();
 if v_member_count+v_pending_invites>=v_max_members then raise exception 'Лимит участников команды достигнут'; end if;
 if p_role='admin' and v_actor_role<>'owner' then raise exception 'Только владелец может приглашать администраторов'; end if;
 v_token=encode(gen_random_bytes(32),'hex');
 v_expires_at=now()+make_interval(hours=>p_expires_in_hours);
 insert into public.workspace_invites(workspace_id,created_by,token_hash,role,expires_at)
 values(v_workspace_id,p_user_id,extensions.digest(v_token,'sha256'),p_role,v_expires_at)
 returning id into v_invite_id;
 return query select v_invite_id,v_token,v_expires_at;
end;
$$;

revoke execute on function public.get_workspace_for_user(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_workspace_for_user(uuid,uuid) to service_role;
revoke execute on function public.list_workspace_members_for_user(uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_workspace_members_for_user(uuid,uuid) to service_role;
revoke execute on function public.list_workspace_invites_for_user(uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_workspace_invites_for_user(uuid,uuid) to service_role;
revoke execute on function public.revoke_workspace_invite_for_user(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.revoke_workspace_invite_for_user(uuid,uuid,uuid) to service_role;
revoke execute on function public.create_workspace_invite_for_user(uuid,integer,uuid,text) from public,anon,authenticated;
grant execute on function public.create_workspace_invite_for_user(uuid,integer,uuid,text) to service_role;