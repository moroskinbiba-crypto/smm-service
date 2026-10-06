create table if not exists public.oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,
  state text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists oauth_states_lookup_idx on public.oauth_states(provider,state,expires_at);
alter table public.oauth_states enable row level security;
create policy oauth_states_client_deny_all on public.oauth_states
  for all to public using (false) with check (false);