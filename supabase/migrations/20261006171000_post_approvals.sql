alter table public.posts
  add column if not exists approval_status text not null default 'not_required',
  add column if not exists approval_requested_by uuid references auth.users(id),
  add column if not exists approval_approved_by uuid references auth.users(id),
  add column if not exists approval_comment text,
  add column if not exists approval_updated_at timestamptz;

alter table public.posts
  drop constraint if exists posts_approval_status_check;
alter table public.posts
  add constraint posts_approval_status_check
  check (approval_status = any (array['not_required'::text,'pending'::text,'approved'::text,'rejected'::text]));

create index if not exists posts_approval_status_idx
  on public.posts (workspace_id, approval_status, updated_at desc);

create table if not exists public.post_approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  post_id uuid not null references public.posts(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,
  reviewed_by uuid references auth.users(id) on delete set null,
  status text not null check (status = any (array['pending'::text,'approved'::text,'rejected'::text])),
  comment text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists post_approvals_workspace_idx
  on public.post_approvals (workspace_id, status, created_at desc);

alter table public.post_approvals enable row level security;
