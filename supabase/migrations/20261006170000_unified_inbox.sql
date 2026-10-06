create table if not exists public.inbox_threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  social_account_id uuid not null references public.social_accounts(id) on delete cascade,
  platform text not null check (platform = any (array['telegram'::text,'vk'::text,'max'::text,'ok'::text,'instagram'::text])),
  external_thread_id text not null,
  thread_type text not null default 'message' check (thread_type = any (array['message'::text,'comment'::text])),
  subject text,
  participant_name text,
  participant_external_id text,
  avatar_url text,
  post_target_id uuid references public.post_targets(id) on delete set null,
  unread_count integer not null default 0,
  last_message_at timestamptz,
  last_message_preview text,
  status text not null default 'open' check (status = any (array['open'::text,'closed'::text])),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (social_account_id, external_thread_id, thread_type)
);

create index if not exists inbox_threads_workspace_updated_idx
  on public.inbox_threads (workspace_id, updated_at desc);

create index if not exists inbox_threads_account_idx
  on public.inbox_threads (social_account_id);

create table if not exists public.inbox_messages (
  id bigint generated always as identity primary key,
  thread_id uuid not null references public.inbox_threads(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  social_account_id uuid not null references public.social_accounts(id) on delete cascade,
  external_message_id text not null,
  direction text not null check (direction = any (array['inbound'::text,'outbound'::text])),
  message_type text not null default 'message' check (message_type = any (array['message'::text,'comment'::text])),
  author_name text,
  author_external_id text,
  body text not null default '',
  parent_external_id text,
  sent_at timestamptz,
  read_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (social_account_id, external_message_id)
);

create index if not exists inbox_messages_thread_idx
  on public.inbox_messages (thread_id, sent_at asc, id asc);

create index if not exists inbox_messages_workspace_idx
  on public.inbox_messages (workspace_id, created_at desc);

alter table public.inbox_threads enable row level security;
alter table public.inbox_messages enable row level security;

drop policy if exists inbox_threads_client_deny_all on public.inbox_threads;
create policy inbox_threads_client_deny_all
  on public.inbox_threads for all to public
  using (false) with check (false);

drop policy if exists inbox_messages_client_deny_all on public.inbox_messages;
create policy inbox_messages_client_deny_all
  on public.inbox_messages for all to public
  using (false) with check (false);

drop trigger if exists inbox_threads_updated_at on public.inbox_threads;
create trigger inbox_threads_updated_at
before update on public.inbox_threads
for each row execute function public.set_updated_at();
