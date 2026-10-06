create table if not exists public.telegram_connection_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null check (mode = any (array['channel'::text,'business'::text])),
  code text not null unique,
  expires_at timestamptz not null,
  telegram_user_id bigint,
  claimed_at timestamptz,
  claimed_chat_id bigint,
  business_connection_id text,
  created_at timestamptz not null default now()
);

create index if not exists telegram_connection_requests_lookup_idx
  on public.telegram_connection_requests (mode, code, expires_at, claimed_at);

create index if not exists telegram_connection_requests_user_idx
  on public.telegram_connection_requests (user_id, mode, expires_at, claimed_at);

create table if not exists public.telegram_service_chats (
  chat_id bigint primary key,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  title text,
  username text,
  chat_type text,
  can_post_messages boolean,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists telegram_service_chats_workspace_idx
  on public.telegram_service_chats (workspace_id, active, updated_at desc);

create table if not exists public.telegram_business_connections (
  connection_id text primary key,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  telegram_user_id bigint not null,
  user_chat_id bigint,
  rights jsonb not null default '{}'::jsonb,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists telegram_business_connections_workspace_idx
  on public.telegram_business_connections (workspace_id, user_id, is_enabled);

alter table public.telegram_connection_requests enable row level security;
alter table public.telegram_service_chats enable row level security;
alter table public.telegram_business_connections enable row level security;

drop policy if exists telegram_connection_requests_client_deny_all on public.telegram_connection_requests;
create policy telegram_connection_requests_client_deny_all
  on public.telegram_connection_requests for all to public using (false) with check (false);

drop policy if exists telegram_service_chats_client_deny_all on public.telegram_service_chats;
create policy telegram_service_chats_client_deny_all
  on public.telegram_service_chats for all to public using (false) with check (false);

drop policy if exists telegram_business_connections_client_deny_all on public.telegram_business_connections;
create policy telegram_business_connections_client_deny_all
  on public.telegram_business_connections for all to public using (false) with check (false);
