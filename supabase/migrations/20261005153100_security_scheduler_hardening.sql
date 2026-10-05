-- Production hardening applied on 2026-10-05.
create schema if not exists private;

create table if not exists private.scheduler_config (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  cron_token text not null default encode(gen_random_bytes(32), 'hex')
);

insert into private.scheduler_config (id, enabled)
values (true, false)
on conflict (id) do nothing;

revoke all on table private.scheduler_config from public, anon, authenticated;
revoke all on schema private from public, anon, authenticated;

create or replace function public.get_scheduler_config()
returns table(enabled boolean, cron_token text)
language sql
security definer
set search_path = private, public
as $$
  select enabled, cron_token from private.scheduler_config where id = true;
$$;

revoke execute on function public.get_scheduler_config() from public, anon, authenticated;
grant execute on function public.get_scheduler_config() to service_role;

drop function if exists public.claim_scheduled_targets(integer);

create function public.claim_scheduled_targets(p_limit integer default 20)
returns table (target_id uuid, post_id uuid, attempts integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with due as (
    select pt.id, pt.post_id
    from public.post_targets pt
    join public.posts p on p.id = pt.post_id
    join public.social_accounts sa on sa.id = pt.social_account_id
    where p.status in ('scheduled','publishing')
      and p.scheduled_at is not null
      and p.scheduled_at <= now()
      and pt.status = 'pending'
      and sa.status = 'connected'
    order by p.scheduled_at, pt.created_at
    for update of pt skip locked
    limit greatest(1, least(p_limit, 100))
  )
  update public.post_targets pt
  set status = 'publishing',
      attempts = pt.attempts + 1,
      last_error = null,
      updated_at = now()
  from due
  where pt.id = due.id
  returning pt.id, pt.post_id, pt.attempts;
end;
$$;

revoke execute on function public.claim_scheduled_targets(integer) from public, anon, authenticated;
grant execute on function public.claim_scheduled_targets(integer) to service_role;

revoke execute on function public.refresh_post_status(uuid) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create index if not exists posts_user_idx on public.posts(user_id);
create index if not exists post_targets_social_account_idx on public.post_targets(social_account_id);
