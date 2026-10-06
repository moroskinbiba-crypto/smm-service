create table if not exists public.max_connection_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  code text not null unique,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  claimed_chat_id bigint,
  created_at timestamptz not null default now()
);
create index if not exists max_connection_requests_lookup_idx
  on public.max_connection_requests(code, expires_at, claimed_at);

create table if not exists public.max_service_chats (
  chat_id bigint primary key,
  title text,
  is_channel boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  active boolean not null default true
);
alter table public.max_connection_requests enable row level security;
alter table public.max_service_chats enable row level security;
create policy max_connection_requests_client_deny_all on public.max_connection_requests for all to public using (false) with check (false);
create policy max_service_chats_client_deny_all on public.max_service_chats for all to public using (false) with check (false);