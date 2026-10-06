create or replace function public.claim_scheduled_targets(p_limit integer default 20)
returns table(target_id uuid, post_id uuid, attempts integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
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
      and pt.status in ('pending','failed')
      and pt.attempts < 5
      and coalesce(pt.next_attempt_at, now()) <= now()
      and sa.status = 'connected'
    order by coalesce(pt.next_attempt_at, p.scheduled_at), p.scheduled_at, pt.created_at
    for update of pt skip locked
    limit greatest(1, least(p_limit, 100))
  )
  update public.post_targets pt
  set
    status = 'publishing',
    attempts = pt.attempts + 1,
    last_error = null,
    next_attempt_at = null,
    updated_at = now()
  from due
  where pt.id = due.id
  returning pt.id, pt.post_id, pt.attempts;
end;
$function$;
