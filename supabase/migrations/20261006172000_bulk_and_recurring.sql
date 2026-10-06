create table if not exists public.post_recurrences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_post_id uuid not null references public.posts(id) on delete cascade,
  interval_days integer not null check (interval_days between 1 and 365),
  next_run_at timestamptz not null,
  end_at timestamptz,
  max_runs integer check (max_runs is null or max_runs between 1 and 1000),
  run_count integer not null default 0,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists post_recurrences_due_idx
  on public.post_recurrences (active, next_run_at);
create index if not exists post_recurrences_workspace_idx
  on public.post_recurrences (workspace_id, active, next_run_at);
alter table public.post_recurrences enable row level security;