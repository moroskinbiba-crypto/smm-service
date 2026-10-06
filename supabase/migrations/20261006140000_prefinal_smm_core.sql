-- Prefinal SMM core: post metrics and encrypted client secrets.
alter table public.post_targets
  add column if not exists metrics jsonb not null default '{}'::jsonb;

alter table public.social_account_secrets
  add column if not exists client_secret_ciphertext bytea;


create index if not exists posts_workspace_schedule_idx
  on public.posts(workspace_id, scheduled_at, status);

create index if not exists post_targets_account_status_idx
  on public.post_targets(social_account_id, status, next_attempt_at);

create or replace function public.upsert_social_account_secret(
  p_social_account_id uuid,
  p_access_token text,
  p_refresh_token text default null,
  p_expires_at timestamptz default null,
  p_client_secret text default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $function$
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
    social_account_id,
    access_token_ciphertext,
    refresh_token_ciphertext,
    client_secret_ciphertext
  )
  values (
    p_social_account_id,
    case when p_access_token is null then null
      else extensions.pgp_sym_encrypt(p_access_token,k,'cipher-algo=aes256') end,
    case when p_refresh_token is null then null
      else extensions.pgp_sym_encrypt(p_refresh_token,k,'cipher-algo=aes256') end,
    case when p_client_secret is null then null
      else extensions.pgp_sym_encrypt(p_client_secret,k,'cipher-algo=aes256') end
  )
  on conflict (social_account_id) do update set
    access_token_ciphertext=excluded.access_token_ciphertext,
    refresh_token_ciphertext=excluded.refresh_token_ciphertext,
    client_secret_ciphertext=excluded.client_secret_ciphertext,
    updated_at=now();

  update public.social_accounts
  set token_expires_at=p_expires_at, updated_at=now()
  where id=p_social_account_id;
end;
$function$;

create or replace function public.get_social_account_secret(p_social_account_id uuid)
returns table(access_token text, refresh_token text, client_secret text)
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  k text;
begin
  select decrypted_secret into k
  from vault.decrypted_secrets
  where name='social_token_encryption_key'
  limit 1;

  if k is null then raise exception 'Token encryption key is not configured'; end if;

  return query
  select
    case when sas.access_token_ciphertext is null then null
      else extensions.pgp_sym_decrypt(sas.access_token_ciphertext,k) end,
    case when sas.refresh_token_ciphertext is null then null
      else extensions.pgp_sym_decrypt(sas.refresh_token_ciphertext,k) end,
    case when sas.client_secret_ciphertext is null then null
      else extensions.pgp_sym_decrypt(sas.client_secret_ciphertext,k) end
  from public.social_account_secrets sas
  where sas.social_account_id=p_social_account_id;
end;
$function$;

revoke execute on function public.get_social_account_secret(uuid) from public, anon, authenticated;
revoke execute on function public.upsert_social_account_secret(uuid,text,text,timestamptz,text) from public, anon, authenticated;
grant execute on function public.get_social_account_secret(uuid) to service_role;
grant execute on function public.upsert_social_account_secret(uuid,text,text,timestamptz,text) to service_role;
