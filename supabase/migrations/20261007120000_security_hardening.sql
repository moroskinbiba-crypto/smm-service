-- TGRMLposting security hardening / queue safety
-- 2026-10-07

revoke insert, update, delete, truncate, references, trigger on all tables in schema public from anon, authenticated;

revoke all on public.platform_admins from anon, authenticated;
revoke all on public.social_account_secrets from anon, authenticated;
revoke all on public.workspace_invites from anon, authenticated;
revoke all on public.telegram_connection_requests from anon, authenticated;
revoke all on public.telegram_notification_requests from anon, authenticated;
revoke all on public.max_connection_requests from anon, authenticated;
revoke all on public.scheduler_runs from anon, authenticated;
revoke all on public.stats_cache from anon, authenticated;
revoke all on public.api_rate_limits from anon, authenticated;

do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname='public'
      and tablename in (
        'workspace_members','workspaces','profiles','posts','post_targets',
        'social_accounts','telegram_notification_subscriptions','platform_admins'
      )
      and cmd <> 'SELECT'
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

drop policy if exists telegram_notification_subscriptions_self_manage on public.telegram_notification_subscriptions;
create policy telegram_notification_subscriptions_select_self
  on public.telegram_notification_subscriptions
  for select to authenticated
  using (user_id=(select auth.uid()));

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname='telegram_notification_subscriptions_membership_fkey'
      and conrelid='public.telegram_notification_subscriptions'::regclass
  ) then
    alter table public.telegram_notification_subscriptions
      add constraint telegram_notification_subscriptions_membership_fkey
      foreign key (workspace_id,user_id)
      references public.workspace_members(workspace_id,user_id)
      on delete cascade;
  end if;
end $$;

alter table public.workspace_members add column if not exists member_suspended_at timestamptz null;
alter table public.workspace_members add column if not exists member_suspended_reason text null;

create or replace function public.admin_set_workspace_limit(p_workspace_id uuid,p_max_members integer)
returns table(workspace_id uuid,max_members integer)
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if current_user not in ('service_role','postgres') then
    raise exception 'Только сервер может изменять лимит команды';
  end if;
  if p_max_members < 1 or p_max_members > 10000 then
    raise exception 'Лимит должен быть от 1 до 10000';
  end if;
  update public.workspaces
  set max_members=greatest(
        p_max_members,
        (select count(*) from public.workspace_members wm where wm.workspace_id=workspaces.id)::integer
      ),
      workspace_kind=case when workspace_kind='personal' and p_max_members>1 then 'team' else workspace_kind end,
      updated_at=now()
  where id=p_workspace_id;
  if not found then raise exception 'Рабочее пространство не найдено'; end if;
  return query select w.id,w.max_members from public.workspaces w where w.id=p_workspace_id;
end;
$function$;

drop function if exists public.create_workspace_invite_for_user(uuid,integer);
drop function if exists public.get_workspace_for_user(uuid);

create or replace function public.enqueue_publication_jobs(p_limit integer default 200)
returns integer language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
declare row_data record; queued_count integer:=0;
begin
  for row_data in
    select pt.id
    from public.post_targets pt
    join public.posts p on p.id=pt.post_id
    join public.social_accounts sa on sa.id=pt.social_account_id
    where p.status in ('scheduled','publishing','failed','partially_published')
      and p.approval_status in ('not_required','approved')
      and p.scheduled_at is not null and p.scheduled_at<=now()
      and pt.status in ('pending','failed') and pt.attempts<5
      and coalesce(pt.next_attempt_at,now())<=now()
      and sa.status='connected'
      and (pt.queue_enqueued_at is null or pt.queue_enqueued_at<now()-interval '20 seconds')
    order by coalesce(pt.next_attempt_at,p.scheduled_at),p.scheduled_at,pt.created_at
    for update of pt skip locked
    limit greatest(1,least(coalesce(p_limit,200),500))
  loop
    perform pgmq.send('publication_jobs',jsonb_build_object('target_id',row_data.id::text,'enqueued_at',now()));
    update public.post_targets set queue_enqueued_at=now() where id=row_data.id;
    queued_count:=queued_count+1;
  end loop;
  return queued_count;
end;
$function$;

create or replace function public.claim_publication_targets(
  p_target_ids uuid[],p_limit integer default 25
)
returns table(target_id uuid,post_id uuid,attempts integer,lock_token uuid,publish_operation_id uuid)
language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
begin
  return query
  with candidates as (
    select pt.id
    from public.post_targets pt
    join public.posts p on p.id=pt.post_id
    join public.social_accounts sa on sa.id=pt.social_account_id
    where pt.id=any(p_target_ids)
      and p.status in ('scheduled','publishing','failed','partially_published')
      and p.approval_status in ('not_required','approved')
      and p.scheduled_at is not null and p.scheduled_at<=now()
      and pt.status in ('pending','failed') and pt.attempts<5
      and coalesce(pt.next_attempt_at,now())<=now()
      and sa.status='connected'
    order by coalesce(pt.next_attempt_at,p.scheduled_at),p.scheduled_at,pt.created_at
    for update of pt skip locked
    limit greatest(1,least(coalesce(p_limit,25),100))
  )
  update public.post_targets pt
  set status='publishing',
      attempts=pt.attempts+1,
      last_error=null,
      next_attempt_at=null,
      lock_token=gen_random_uuid(),
      lock_until=now()+interval '5 minutes',
      last_attempt_at=now(),
      queue_enqueued_at=now()
  from candidates where pt.id=candidates.id
  returning pt.id,pt.post_id,pt.attempts,pt.lock_token,pt.publish_operation_id;
end;
$function$;

create or replace function public.recover_stale_publication_targets(p_limit integer default 100)
returns integer language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
declare recovered_count integer;
begin
  with stale as (
    select id
    from public.post_targets
    where status='publishing'
      and lock_until is not null
      and lock_until<now()
    order by lock_until
    for update skip locked
    limit greatest(1,least(coalesce(p_limit,100),500))
  )
  update public.post_targets pt
  set status='failed',
      attempts=5,
      lock_token=null,
      lock_until=null,
      queue_enqueued_at=null,
      next_attempt_at=null,
      last_error=coalesce(
        pt.last_error,
        'Публикация остановлена после истечения блокировки. Требуется ручная проверка, чтобы исключить дубль.'
      ),
      updated_at=now()
  from stale where pt.id=stale.id;
  get diagnostics recovered_count=row_count;
  return recovered_count;
end;
$function$;

drop function if exists public.save_post_bundle(uuid,uuid,uuid,text,jsonb,text,timestamptz,jsonb);
create or replace function public.save_post_bundle(
  p_post_id uuid,p_workspace_id uuid,p_user_id uuid,p_body text,p_media jsonb,p_status text,
  p_scheduled_at timestamptz,p_targets jsonb
)
returns uuid language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
declare
  v_post_id uuid;
  v_existing_status text;
  v_existing_approval text;
  v_approval_status text:='not_required';
  v_target jsonb;
  v_account_id uuid;
  v_platform text;
  v_publication_type text;
begin
  if current_user not in ('service_role','postgres') then
    raise exception 'Операция доступна только серверу';
  end if;
  if jsonb_typeof(coalesce(p_media,'[]'::jsonb))<>'array' then raise exception 'media must be an array'; end if;
  if jsonb_typeof(coalesce(p_targets,'[]'::jsonb))<>'array' then raise exception 'targets must be an array'; end if;

  if p_post_id is null then
    insert into public.posts(
      workspace_id,user_id,body,media,status,scheduled_at,approval_status,updated_at
    )
    values(
      p_workspace_id,p_user_id,coalesce(p_body,''),coalesce(p_media,'[]'::jsonb),
      p_status,p_scheduled_at,'not_required',now()
    )
    returning id into v_post_id;
  else
    select status,approval_status into v_existing_status,v_existing_approval
    from public.posts where id=p_post_id and workspace_id=p_workspace_id for update;

    if v_existing_status is null then raise exception 'Публикация не найдена'; end if;
    if v_existing_status='publishing' then raise exception 'Нельзя изменить публикацию во время отправки'; end if;

    v_approval_status:=case when coalesce(v_existing_approval,'not_required')='not_required' then 'not_required' else 'pending' end;

    update public.posts
    set user_id=p_user_id,
        body=coalesce(p_body,''),
        media=coalesce(p_media,'[]'::jsonb),
        status=p_status,
        scheduled_at=p_scheduled_at,
        approval_status=v_approval_status,
        approval_requested_by=case when v_approval_status='pending' then p_user_id else null end,
        approval_approved_by=null,
        approval_comment=null,
        approval_updated_at=case when v_approval_status='pending' then now() else null end,
        updated_at=now()
    where id=p_post_id and workspace_id=p_workspace_id;

    v_post_id:=p_post_id;

    if v_approval_status='pending' then
      update public.post_approvals
      set status='rejected',reviewed_at=now(),comment='Предыдущий запрос закрыт изменением публикации.'
      where post_id=v_post_id and status='pending';

      insert into public.post_approvals(workspace_id,post_id,requested_by,status)
      values(p_workspace_id,v_post_id,p_user_id,'pending');
    else
      update public.post_approvals
      set status='rejected',reviewed_at=now(),comment='Предыдущий запрос закрыт.'
      where post_id=v_post_id and status='pending';
    end if;
  end if;

  delete from public.post_targets where post_id=v_post_id;

  for v_target in select value from jsonb_array_elements(coalesce(p_targets,'[]'::jsonb)) loop
    v_account_id:=nullif(v_target->>'social_account_id','')::uuid;
    v_platform:=nullif(v_target->>'platform','');
    v_publication_type:=coalesce(nullif(v_target->>'publication_type',''),'feed');

    if v_account_id is null or v_platform is null then raise exception 'Некорректная цель публикации'; end if;

    if not exists(
      select 1 from public.social_accounts sa
      where sa.id=v_account_id and sa.workspace_id=p_workspace_id and sa.platform=v_platform
    ) then
      raise exception 'Один из выбранных аккаунтов недоступен';
    end if;

    insert into public.post_targets(post_id,social_account_id,platform,publication_type,status)
    values(
      v_post_id,v_account_id,v_platform,v_publication_type,
      case when p_status='scheduled' then 'pending' else 'waiting' end
    );
  end loop;

  return v_post_id;
end;
$function$;

revoke all on function public.save_post_bundle(uuid,uuid,uuid,text,jsonb,text,timestamptz,jsonb) from anon,authenticated;
grant execute on function public.save_post_bundle(uuid,uuid,uuid,text,jsonb,text,timestamptz,jsonb) to service_role;

create or replace function public.cleanup_scaling_runtime()
returns jsonb language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
declare
  rate_deleted bigint:=0;
  cache_deleted bigint:=0;
  runs_deleted bigint:=0;
  logs_deleted bigint:=0;
  cron_runs_deleted bigint:=0;
begin
  delete from public.api_rate_limits where updated_at<now()-interval '2 hours';
  get diagnostics rate_deleted=row_count;

  delete from public.stats_cache where expires_at<now()-interval '1 hour';
  get diagnostics cache_deleted=row_count;

  delete from public.scheduler_runs where started_at<now()-interval '14 days';
  get diagnostics runs_deleted=row_count;

  delete from public.publication_logs where created_at<now()-interval '30 days';
  get diagnostics logs_deleted=row_count;

  begin
    delete from cron.job_run_details where end_time<now()-interval '7 days';
    get diagnostics cron_runs_deleted=row_count;
  exception when undefined_table or insufficient_privilege then
    cron_runs_deleted:=0;
  end;

  return jsonb_build_object(
    'rate_limits_deleted',rate_deleted,
    'stats_cache_deleted',cache_deleted,
    'scheduler_runs_deleted',runs_deleted,
    'publication_logs_deleted',logs_deleted,
    'cron_job_runs_deleted',cron_runs_deleted,
    'cleaned_at',now()
  );
end;
$function$;

revoke all on function public.admin_set_workspace_limit(uuid,integer) from anon,authenticated;
grant execute on function public.admin_set_workspace_limit(uuid,integer) to service_role;

revoke all on function public.enqueue_publication_jobs(integer) from anon,authenticated;
grant execute on function public.enqueue_publication_jobs(integer) to service_role;

revoke all on function public.claim_publication_targets(uuid[],integer) from anon,authenticated;
grant execute on function public.claim_publication_targets(uuid[],integer) to service_role;

revoke all on function public.recover_stale_publication_targets(integer) from anon,authenticated;
grant execute on function public.recover_stale_publication_targets(integer) to service_role;

revoke all on function public.cleanup_scaling_runtime() from anon,authenticated;
grant execute on function public.cleanup_scaling_runtime() to service_role;

revoke all on function public.get_social_account_secret(uuid) from anon,authenticated;
revoke all on function public.upsert_social_account_secret(uuid,text,text,timestamptz) from anon,authenticated;
revoke all on function public.upsert_social_account_secret(uuid,text,text,timestamptz,text) from anon,authenticated;
revoke all on function public.delete_social_account_secret(uuid) from anon,authenticated;
grant execute on function public.get_social_account_secret(uuid) to service_role;
grant execute on function public.upsert_social_account_secret(uuid,text,text,timestamptz) to service_role;
grant execute on function public.upsert_social_account_secret(uuid,text,text,timestamptz,text) to service_role;
grant execute on function public.delete_social_account_secret(uuid) to service_role;

 
-- Keep future postgres-owned migrations hardened as well.
alter default privileges for role postgres in schema public revoke all on tables from anon,authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon,authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon,authenticated;

revoke all on function public.save_post_bundle(uuid,uuid,uuid,text,jsonb,text,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.save_post_bundle(uuid,uuid,uuid,text,jsonb,text,timestamptz,jsonb) to service_role;

create index if not exists telegram_notification_subscriptions_membership_idx
  on public.telegram_notification_subscriptions(workspace_id,user_id);

revoke all on function public.set_updated_at() from public,anon,authenticated;

 
create or replace function public.create_recurrence_instance(p_recurrence_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  rec record;
  src record;
  target record;
  cloned_id uuid;
  cloned_approval text;
  next_run timestamptz;
  next_count integer;
  should_stop boolean;
begin
  if current_user not in ('service_role','postgres') then raise exception 'Операция доступна только серверу'; end if;

  select * into rec from public.post_recurrences where id=p_recurrence_id for update;
  if not found or rec.active is not true then return null; end if;
  if rec.next_run_at is null or rec.next_run_at>now() then return null; end if;

  if rec.max_runs is not null and rec.run_count>=rec.max_runs then
    update public.post_recurrences set active=false,updated_at=now() where id=rec.id;
    return null;
  end if;

  select id,user_id,body,media,approval_status,approval_requested_by,approval_approved_by,approval_comment
  into src
  from public.posts
  where id=rec.source_post_id and workspace_id=rec.workspace_id
  for share;

  if not found then
    update public.post_recurrences set active=false,updated_at=now() where id=rec.id;
    return null;
  end if;

  cloned_approval:=case
    when src.approval_status='approved' then 'approved'
    when src.approval_status='pending' then 'pending'
    else 'not_required'
  end;

  insert into public.posts(
    workspace_id,user_id,body,media,status,scheduled_at,approval_status,
    approval_requested_by,approval_approved_by,approval_comment,approval_updated_at
  )
  values(
    rec.workspace_id,src.user_id,coalesce(src.body,''),coalesce(src.media,'[]'::jsonb),
    'scheduled',rec.next_run_at,cloned_approval,
    case when cloned_approval='pending' then src.approval_requested_by else null end,
    case when cloned_approval='approved' then src.approval_approved_by else null end,
    case when cloned_approval='approved' then src.approval_comment else null end,
    case when cloned_approval<>'not_required' then now() else null end
  )
  returning id into cloned_id;

  if cloned_approval<>'not_required' then
    insert into public.post_approvals(
      workspace_id,post_id,requested_by,reviewed_by,status,comment,reviewed_at
    )
    values(
      rec.workspace_id,cloned_id,src.approval_requested_by,
      case when cloned_approval='approved' then src.approval_approved_by else null end,
      cloned_approval,src.approval_comment,
      case when cloned_approval='approved' then now() else null end
    );
  end if;

  for target in
    select social_account_id,platform,publication_type
    from public.post_targets
    where post_id=src.id
    order by created_at
  loop
    insert into public.post_targets(post_id,social_account_id,platform,publication_type,status)
    values(cloned_id,target.social_account_id,target.platform,coalesce(target.publication_type,'feed'),'pending');
  end loop;

  next_run:=rec.next_run_at+(rec.interval_days*interval '1 day');
  next_count:=coalesce(rec.run_count,0)+1;
  should_stop:=(rec.max_runs is not null and next_count>=rec.max_runs)
    or (rec.end_at is not null and next_run>rec.end_at);

  update public.post_recurrences
  set run_count=next_count,next_run_at=next_run,active=not should_stop,updated_at=now()
  where id=rec.id;

  return cloned_id;
end;
$function$;

revoke all on function public.create_recurrence_instance(uuid) from public,anon,authenticated;
grant execute on function public.create_recurrence_instance(uuid) to service_role;

 
drop function if exists public.list_workspace_invites_for_user(uuid);
drop function if exists public.revoke_workspace_invite_for_user(uuid,uuid);

create unique index if not exists workspace_members_one_owner_idx
  on public.workspace_members(workspace_id)
  where role='owner';

create or replace function public.create_workspace_invite_for_user(
  p_user_id uuid,
  p_expires_in_hours integer,
  p_workspace_id uuid,
  p_role text
)
returns table(invite_id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path to 'public','extensions'
as $function$
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
 select x.workspace_id,x.role,x.workspace_kind,x.max_members
 into v_workspace_id,v_actor_role,v_workspace_kind,v_max_members
 from public.get_workspace_for_user(p_user_id,p_workspace_id) x
 limit 1;
 if v_workspace_id is null or v_actor_role not in ('owner','admin') then
   raise exception 'Создавать приглашения может только руководитель';
 end if;
 perform 1 from public.workspaces where id=v_workspace_id for update;
 if p_expires_in_hours<1 or p_expires_in_hours>720 then raise exception 'Invalid invitation lifetime'; end if;
 if p_role not in ('editor','publisher','approver','viewer','admin') then raise exception 'Invalid invitation role'; end if;
 if v_workspace_kind='personal' then
   update public.workspaces
   set workspace_kind='team',max_members=greatest(max_members,10),updated_at=now()
   where id=v_workspace_id;
   v_max_members=greatest(v_max_members,10);
 end if;
 select count(*) into v_member_count from public.workspace_members where workspace_id=v_workspace_id;
 select count(*) into v_pending_invites
 from public.workspace_invites where workspace_id=v_workspace_id and used_at is null and expires_at>now();
 if v_member_count+v_pending_invites>=v_max_members then raise exception 'Лимит участников команды достигнут'; end if;
 if p_role='admin' and v_actor_role<>'owner' then raise exception 'Только владелец может приглашать администраторов'; end if;
 v_token=encode(gen_random_bytes(32),'hex');
 v_expires_at=now()+make_interval(hours=>p_expires_in_hours);
 insert into public.workspace_invites(workspace_id,created_by,token_hash,role,expires_at)
 values(v_workspace_id,p_user_id,extensions.digest(v_token,'sha256'),p_role,v_expires_at)
 returning id into v_invite_id;
 return query select v_invite_id,v_token,v_expires_at;
end;
$function$;

create or replace function public.accept_workspace_invite_for_user(
  p_user_id uuid,
  p_token text
)
returns table(workspace_id uuid,workspace_name text,workspace_timezone text,role text)
language plpgsql
security definer
set search_path to 'public','extensions'
as $function$
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
 select wi.workspace_id,wi.role,wi.created_by,wi.expires_at,wi.used_at
 into v_workspace_id,v_role,v_inviter,v_expires_at,v_used_at
 from public.workspace_invites wi
 where wi.token_hash=v_hash
 for update;
 if v_workspace_id is null then raise exception 'Invitation not found'; end if;
 if v_used_at is not null then raise exception 'Invitation has already been used'; end if;
 if v_expires_at<=now() then raise exception 'Invitation has expired'; end if;
 select max_members into v_max_members
 from public.workspaces where id=v_workspace_id for update;
 select count(*) into v_member_count from public.workspace_members where workspace_id=v_workspace_id;
 if v_member_count>=coalesce(v_max_members,10) then raise exception 'Лимит участников команды достигнут'; end if;
 if exists(select 1 from public.workspace_members where workspace_id=v_workspace_id and user_id=p_user_id) then
   raise exception 'You are already a member of this workspace';
 end if;
 v_personal_workspace_id := public.ensure_personal_workspace_for_user(p_user_id);
 select w.name,w.timezone into v_workspace_name,v_workspace_timezone from public.workspaces w where w.id=v_workspace_id;
 insert into public.workspace_members(workspace_id,user_id,role,invited_by)
 values(v_workspace_id,p_user_id,v_role,v_inviter);
 insert into public.profiles(id,workspace_id,timezone)
 values(p_user_id,v_personal_workspace_id,v_workspace_timezone)
 on conflict(id) do update
 set workspace_id=coalesce(public.profiles.workspace_id,excluded.workspace_id),updated_at=now();
 update public.workspace_invites set used_at=now(),used_by=p_user_id where token_hash=v_hash and used_at is null;
 return query select v_workspace_id,v_workspace_name,v_workspace_timezone,v_role;
end;
$function$;

revoke all on function public.create_workspace_invite_for_user(uuid,integer,uuid,text) from public,anon,authenticated;
grant execute on function public.create_workspace_invite_for_user(uuid,integer,uuid,text) to service_role;
revoke all on function public.accept_workspace_invite_for_user(uuid,text) from public,anon,authenticated;
grant execute on function public.accept_workspace_invite_for_user(uuid,text) to service_role;

drop function if exists public.create_workspace_invite_for_user(uuid,integer);
drop function if exists public.get_workspace_for_user(uuid);

 
create or replace function public.request_post_approval(
  p_post_id uuid,p_workspace_id uuid,p_user_id uuid
)
returns uuid
language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
declare v_role text; v_status text; v_request_id uuid;
begin
  select wm.role into v_role
  from public.workspace_members wm
  where wm.workspace_id=p_workspace_id and wm.user_id=p_user_id;
  if v_role is null or v_role not in ('owner','admin','editor','publisher') then
    raise exception 'Недостаточно прав для отправки на согласование';
  end if;
  select status into v_status from public.posts
  where id=p_post_id and workspace_id=p_workspace_id
  for update;
  if v_status is null then raise exception 'Публикация не найдена'; end if;
  if v_status='publishing' then raise exception 'Нельзя отправить на согласование публикацию во время отправки'; end if;

  update public.post_approvals
  set status='rejected',reviewed_at=now(),comment='Предыдущий запрос закрыт новым запросом'
  where post_id=p_post_id and status='pending';

  update public.posts
  set approval_status='pending',approval_requested_by=p_user_id,approval_approved_by=null,
      approval_comment=null,approval_updated_at=now(),updated_at=now()
  where id=p_post_id and workspace_id=p_workspace_id;

  insert into public.post_approvals(workspace_id,post_id,requested_by,status)
  values(p_workspace_id,p_post_id,p_user_id,'pending')
  returning id into v_request_id;
  return v_request_id;
end;
$function$;

create or replace function public.review_post_approval(
  p_post_id uuid,p_workspace_id uuid,p_reviewer_id uuid,p_decision text,p_comment text
)
returns table(requested_by uuid,decision text)
language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
declare v_role text; v_requested_by uuid; v_approval_id uuid;
begin
  select wm.role into v_role
  from public.workspace_members wm
  where wm.workspace_id=p_workspace_id and wm.user_id=p_reviewer_id;
  if v_role is null or v_role not in ('owner','admin','approver') then
    raise exception 'Согласовывать публикации может только руководитель или согласующий';
  end if;
  if p_decision not in ('approved','rejected') then raise exception 'Некорректное решение'; end if;

  perform 1 from public.posts
  where id=p_post_id and workspace_id=p_workspace_id and approval_status='pending'
  for update;
  if not found then raise exception 'Эта публикация больше не ожидает согласования'; end if;

  select pa.id,pa.requested_by into v_approval_id,v_requested_by
  from public.post_approvals pa
  where pa.post_id=p_post_id and pa.status='pending'
  order by pa.created_at desc
  limit 1
  for update;

  if v_approval_id is null then raise exception 'Запрос на согласование не найден'; end if;
  if v_requested_by=p_reviewer_id then raise exception 'Нельзя согласовать собственную публикацию'; end if;

  update public.posts
  set approval_status=p_decision,approval_approved_by=p_reviewer_id,
      approval_comment=nullif(trim(coalesce(p_comment,'')),''),
      approval_updated_at=now(),updated_at=now()
  where id=p_post_id and workspace_id=p_workspace_id;

  update public.post_approvals
  set status=p_decision,reviewed_by=p_reviewer_id,
      comment=nullif(trim(coalesce(p_comment,'')),''),
      reviewed_at=now()
  where id=v_approval_id;

  return query select v_requested_by,p_decision;
end;
$function$;

revoke all on function public.request_post_approval(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.request_post_approval(uuid,uuid,uuid) to service_role;
revoke all on function public.review_post_approval(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.review_post_approval(uuid,uuid,uuid,text,text) to service_role;
