alter table public.workspaces add column if not exists approvals_enabled boolean not null default false;

drop function if exists public.get_workspace_for_user(uuid,uuid);
create or replace function public.get_workspace_for_user(p_user_id uuid,p_workspace_id uuid)
returns table(workspace_id uuid,workspace_name text,workspace_timezone text,role text,workspace_kind text,max_members integer,member_count bigint,approvals_enabled boolean)
language sql stable security definer set search_path to 'public'
as $function$
select w.id,w.name,w.timezone,wm.role,w.workspace_kind,w.max_members,
       (select count(*) from public.workspace_members m2 where m2.workspace_id=w.id),
       w.approvals_enabled
from public.workspace_members wm
join public.workspaces w on w.id=wm.workspace_id
where wm.user_id=p_user_id and (p_workspace_id is null or w.id=p_workspace_id)
order by case when w.workspace_kind='personal' then 0 else 1 end,wm.created_at asc
limit 1;
$function$;

drop function if exists public.list_workspaces_for_user(uuid);
create or replace function public.list_workspaces_for_user(p_user_id uuid)
returns table(workspace_id uuid,workspace_name text,workspace_timezone text,role text,workspace_kind text,max_members integer,member_count bigint,approvals_enabled boolean)
language sql stable security definer set search_path to 'public'
as $function$
select w.id,w.name,w.timezone,wm.role,w.workspace_kind,w.max_members,
       (select count(*) from public.workspace_members m2 where m2.workspace_id=w.id),
       w.approvals_enabled
from public.workspace_members wm
join public.workspaces w on w.id=wm.workspace_id
where wm.user_id=p_user_id
order by case when w.workspace_kind='personal' then 0 else 1 end,w.created_at asc;
$function$;

create or replace function public.set_workspace_approval_mode(p_workspace_id uuid,p_user_id uuid,p_enabled boolean)
returns table(workspace_id uuid,approvals_enabled boolean)
language plpgsql security definer set search_path to 'public'
as $function$
declare actor_role text;
begin
select wm.role into actor_role from public.workspace_members wm where wm.workspace_id=p_workspace_id and wm.user_id=p_user_id;
if actor_role is null or actor_role not in ('owner','admin') then raise exception 'Изменять режим согласования может только руководитель'; end if;
update public.workspaces set approvals_enabled=p_enabled,updated_at=now() where id=p_workspace_id;
if not p_enabled then
  update public.post_approvals set status='rejected',reviewed_at=now(),comment='Согласование выключено для рабочего пространства.'
  where workspace_id=p_workspace_id and status='pending';
  update public.posts set approval_status='not_required',approval_requested_by=null,approval_approved_by=null,approval_comment=null,approval_updated_at=now(),updated_at=now()
  where workspace_id=p_workspace_id and approval_status='pending';
end if;
return query select w.id,w.approvals_enabled from public.workspaces w where w.id=p_workspace_id;
end;
$function$;

revoke all on function public.set_workspace_approval_mode(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.set_workspace_approval_mode(uuid,uuid,boolean) to service_role;

drop function if exists public.save_post_bundle(uuid,uuid,uuid,text,jsonb,text,timestamptz,jsonb);
create or replace function public.save_post_bundle(p_post_id uuid,p_workspace_id uuid,p_user_id uuid,p_body text,p_media jsonb,p_status text,p_scheduled_at timestamptz,p_targets jsonb)
returns uuid language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
declare
v_post_id uuid; v_existing_status text; v_approval_status text:='not_required'; v_approvals_enabled boolean:=false;
v_target jsonb; v_account_id uuid; v_platform text; v_publication_type text;
begin
if current_user not in ('service_role','postgres') then raise exception 'Операция доступна только серверу'; end if;
if jsonb_typeof(coalesce(p_media,'[]'::jsonb))<>'array' then raise exception 'media must be an array'; end if;
if jsonb_typeof(coalesce(p_targets,'[]'::jsonb))<>'array' then raise exception 'targets must be an array'; end if;
select coalesce(w.approvals_enabled,false) into v_approvals_enabled from public.workspaces w where w.id=p_workspace_id;
if p_post_id is null then
  v_approval_status:=case when v_approvals_enabled and p_status<>'draft' then 'pending' else 'not_required' end;
  insert into public.posts(workspace_id,user_id,body,media,status,scheduled_at,approval_status,approval_requested_by,approval_updated_at,updated_at)
  values(p_workspace_id,p_user_id,coalesce(p_body,''),coalesce(p_media,'[]'::jsonb),p_status,p_scheduled_at,v_approval_status,
    case when v_approval_status='pending' then p_user_id else null end,
    case when v_approval_status='pending' then now() else null end,now())
  returning id into v_post_id;
  if v_approval_status='pending' then insert into public.post_approvals(workspace_id,post_id,requested_by,status) values(p_workspace_id,v_post_id,p_user_id,'pending'); end if;
else
  select status into v_existing_status from public.posts where id=p_post_id and workspace_id=p_workspace_id for update;
  if v_existing_status is null then raise exception 'Публикация не найдена'; end if;
  if v_existing_status='publishing' then raise exception 'Нельзя изменить публикацию во время отправки'; end if;
  v_approval_status:=case when v_approvals_enabled and p_status<>'draft' then 'pending' else 'not_required' end;
  update public.posts
  set user_id=p_user_id,body=coalesce(p_body,''),media=coalesce(p_media,'[]'::jsonb),status=p_status,scheduled_at=p_scheduled_at,
      approval_status=v_approval_status,approval_requested_by=case when v_approval_status='pending' then p_user_id else null end,
      approval_approved_by=null,approval_comment=null,approval_updated_at=case when v_approval_status='pending' then now() else null end,updated_at=now()
  where id=p_post_id and workspace_id=p_workspace_id;
  v_post_id:=p_post_id;
  update public.post_approvals set status='rejected',reviewed_at=now(),comment='Запрос закрыт изменением публикации.' where post_id=v_post_id and status='pending';
  if v_approval_status='pending' then insert into public.post_approvals(workspace_id,post_id,requested_by,status) values(p_workspace_id,v_post_id,p_user_id,'pending'); end if;
end if;
delete from public.post_targets where post_id=v_post_id;
for v_target in select value from jsonb_array_elements(coalesce(p_targets,'[]'::jsonb)) loop
  v_account_id:=nullif(v_target->>'social_account_id','')::uuid;
  v_platform:=nullif(v_target->>'platform','');
  v_publication_type:=coalesce(nullif(v_target->>'publication_type',''),'feed');
  if v_account_id is null or v_platform is null then raise exception 'Некорректная цель публикации'; end if;
  if not exists(select 1 from public.social_accounts sa where sa.id=v_account_id and sa.workspace_id=p_workspace_id and sa.platform=v_platform) then raise exception 'Один из выбранных аккаунтов недоступен'; end if;
  insert into public.post_targets(post_id,social_account_id,platform,publication_type,status)
  values(v_post_id,v_account_id,v_platform,v_publication_type,case when p_status='scheduled' then 'pending' else 'waiting' end);
end loop;
return v_post_id;
end;
$function$;

revoke all on function public.save_post_bundle(uuid,uuid,uuid,text,jsonb,text,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.save_post_bundle(uuid,uuid,uuid,text,jsonb,text,timestamptz,jsonb) to service_role;

create or replace function public.create_recurrence_instance(p_recurrence_id uuid)
returns uuid language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
declare rec record; src record; target record; cloned_id uuid; cloned_approval text; next_run timestamptz; next_count integer; should_stop boolean; approvals_enabled boolean:=false;
begin
if current_user not in ('service_role','postgres') then raise exception 'Операция доступна только серверу'; end if;
select * into rec from public.post_recurrences where id=p_recurrence_id for update;
if not found or rec.active is not true then return null; end if;
if rec.next_run_at is null or rec.next_run_at>now() then return null; end if;
if rec.max_runs is not null and rec.run_count>=rec.max_runs then update public.post_recurrences set active=false,updated_at=now() where id=rec.id; return null; end if;
select coalesce(w.approvals_enabled,false) into approvals_enabled from public.workspaces w where w.id=rec.workspace_id;
select id,user_id,body,media,approval_status,approval_requested_by,approval_approved_by,approval_comment into src from public.posts where id=rec.source_post_id and workspace_id=rec.workspace_id for share;
if not found then update public.post_recurrences set active=false,updated_at=now() where id=rec.id; return null; end if;
cloned_approval:=case when approvals_enabled then 'pending' else 'not_required' end;
insert into public.posts(workspace_id,user_id,body,media,status,scheduled_at,approval_status,approval_requested_by,approval_updated_at)
values(rec.workspace_id,src.user_id,coalesce(src.body,''),coalesce(src.media,'[]'::jsonb),'scheduled',rec.next_run_at,cloned_approval,
  case when cloned_approval='pending' then src.user_id else null end,
  case when cloned_approval='pending' then now() else null end)
returning id into cloned_id;
if cloned_approval='pending' then insert into public.post_approvals(workspace_id,post_id,requested_by,status) values(rec.workspace_id,cloned_id,src.user_id,'pending'); end if;
for target in select social_account_id,platform,publication_type from public.post_targets where post_id=src.id order by created_at loop
  insert into public.post_targets(post_id,social_account_id,platform,publication_type,status) values(cloned_id,target.social_account_id,target.platform,coalesce(target.publication_type,'feed'),'pending');
end loop;
next_run:=rec.next_run_at+(rec.interval_days*interval '1 day'); next_count:=coalesce(rec.run_count,0)+1;
should_stop:=(rec.max_runs is not null and next_count>=rec.max_runs) or (rec.end_at is not null and next_run>rec.end_at);
update public.post_recurrences set run_count=next_count,next_run_at=next_run,active=not should_stop,updated_at=now() where id=rec.id;
return cloned_id;
end;
$function$;

revoke all on function public.create_recurrence_instance(uuid) from public,anon,authenticated;
grant execute on function public.create_recurrence_instance(uuid) to service_role;

create index if not exists workspaces_approvals_enabled_idx on public.workspaces(id,approvals_enabled);
