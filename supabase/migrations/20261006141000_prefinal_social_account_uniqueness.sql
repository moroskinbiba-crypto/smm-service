create unique index if not exists social_accounts_workspace_platform_external_unique
on public.social_accounts(workspace_id, platform, external_id)
where external_id is not null and external_id <> '';
