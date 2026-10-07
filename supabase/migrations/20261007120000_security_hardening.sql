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
