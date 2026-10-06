create table if not exists public.automation_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  trigger_type text not null check (trigger_type = any (array['publication_success'::text,'publication_failure'::text,'approval_requested'::text,'approval_reviewed'::text])),
  action_type text not null check (action_type = any (array['notify_team'::text])),
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists automation_rules_workspace_idx on public.automation_rules(workspace_id,enabled,created_at desc);
alter table public.automation_rules enable row level security;