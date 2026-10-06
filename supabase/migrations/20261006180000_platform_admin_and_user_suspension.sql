create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;

drop policy if exists platform_admins_deny_all on public.platform_admins;
create policy platform_admins_deny_all
  on public.platform_admins
  for all
  to public
  using (false)
  with check (false);

alter table public.profiles
  add column if not exists suspended_at timestamptz null,
  add column if not exists suspended_reason text null;

create index if not exists profiles_suspended_at_idx
  on public.profiles (suspended_at)
  where suspended_at is not null;

insert into public.platform_admins (user_id)
select id
from auth.users
where lower(email) = lower('truegromle@gmail.com')
on conflict (user_id) do nothing;
