create table if not exists public.tracked_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  slug text not null unique,
  destination_url text not null,
  source text,
  medium text,
  campaign text,
  content text,
  clicks integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tracked_links_workspace_idx on public.tracked_links(workspace_id,created_at desc);
alter table public.tracked_links enable row level security;
