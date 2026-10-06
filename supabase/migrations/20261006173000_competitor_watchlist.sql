create table if not exists public.competitors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  platform text not null check (platform = any (array['telegram'::text,'vk'::text,'max'::text,'ok'::text])),
  name text not null,
  external_ref text not null,
  url text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, platform, external_ref)
);

create table if not exists public.competitor_snapshots (
  id bigint generated always as identity primary key,
  competitor_id uuid not null references public.competitors(id) on delete cascade,
  followers integer,
  posts_7d integer,
  avg_views numeric,
  avg_engagement numeric,
  last_post_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  collected_at timestamptz not null default now()
);

create index if not exists competitors_workspace_idx on public.competitors(workspace_id,active,created_at desc);
create index if not exists competitor_snapshots_idx on public.competitor_snapshots(competitor_id,collected_at desc);
alter table public.competitors enable row level security;
alter table public.competitor_snapshots enable row level security;
