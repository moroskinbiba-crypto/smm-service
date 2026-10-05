-- Workspace and encrypted social-token storage baseline.
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  timezone text not null default 'Europe/Moscow',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner'
    check (role in ('owner','admin','editor','publisher','approver','viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id,user_id)
);

alter table public.profiles add column if not exists workspace_id uuid;
alter table public.social_accounts add column if not exists workspace_id uuid;
alter table public.posts add column if not exists workspace_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname='profiles_workspace_id_fkey') then
    alter table public.profiles
      add constraint profiles_workspace_id_fkey
      foreign key (workspace_id) references public.workspaces(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname='social_accounts_workspace_id_fkey') then
    alter table public.social_accounts
      add constraint social_accounts_workspace_id_fkey
      foreign key (workspace_id) references public.workspaces(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname='posts_workspace_id_fkey') then
    alter table public.posts
      add constraint posts_workspace_id_fkey
      foreign key (workspace_id) references public.workspaces(id) on delete cascade;
  end if;
end $$;

create index if not exists workspaces_owner_idx on public.workspaces(owner_id);
create index if not exists workspace_members_user_idx on public.workspace_members(user_id);
create index if not exists workspace_members_workspace_idx on public.workspace_members(workspace_id);
create index if not exists profiles_workspace_idx on public.profiles(workspace_id);
create index if not exists social_accounts_workspace_idx on public.social_accounts(workspace_id);
create index if not exists posts_workspace_idx on public.posts(workspace_id);

create table if not exists public.social_account_secrets (
  social_account_id uuid primary key references public.social_accounts(id) on delete cascade,
  access_token_ciphertext bytea,
  refresh_token_ciphertext bytea,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.social_account_secrets enable row level security;

drop policy if exists social_account_secrets_deny_all on public.social_account_secrets;
create policy social_account_secrets_deny_all
on public.social_account_secrets for all to public
using (false)
with check (false);

create or replace function public.upsert_social_account_secret(
  p_social_account_id uuid,
  p_access_token text,
  p_refresh_token text default null,
  p_expires_at timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  k text;
begin
  select decrypted_secret into k
  from vault.decrypted_secrets
  where name='social_token_encryption_key'
  limit 1;

  if k is null then
    raise exception 'Token encryption key is not configured';
  end if;

  insert into public.social_account_secrets(
    social_account_id, access_token_ciphertext, refresh_token_ciphertext
  )
  values (
    p_social_account_id,
    case when p_access_token is null then null
      else extensions.pgp_sym_encrypt(p_access_token,k,'cipher-algo=aes256') end,
    case when p_refresh_token is null then null
      else extensions.pgp_sym_encrypt(p_refresh_token,k,'cipher-algo=aes256') end
  )
  on conflict (social_account_id) do update set
    access_token_ciphertext=excluded.access_token_ciphertext,
    refresh_token_ciphertext=excluded.refresh_token_ciphertext,
    updated_at=now();

  update public.social_accounts
  set token_expires_at=p_expires_at, updated_at=now()
  where id=p_social_account_id;
end;
$$;

create or replace function public.delete_social_account_secret(p_social_account_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.social_account_secrets
  where social_account_id=p_social_account_id;
$$;

revoke execute on function public.upsert_social_account_secret(uuid,text,text,timestamptz) from public, anon, authenticated;
revoke execute on function public.delete_social_account_secret(uuid) from public, anon, authenticated;
grant execute on function public.upsert_social_account_secret(uuid,text,text,timestamptz) to service_role;
grant execute on function public.delete_social_account_secret(uuid) to service_role;
