-- Final security/storage cleanup after the architecture audit.
select cron.unschedule(jobid)
from cron.job
where jobname in ('smm-scheduler-every-minute');

drop function if exists public.run_scheduler_http();
drop table if exists public.internal_config;

drop policy if exists media_select_own on storage.objects;
drop policy if exists media_insert_own on storage.objects;
drop policy if exists media_update_own on storage.objects;
drop policy if exists media_delete_own on storage.objects;
drop policy if exists media_select_workspace on storage.objects;
drop policy if exists media_insert_workspace on storage.objects;
drop policy if exists media_update_workspace on storage.objects;
drop policy if exists media_delete_workspace on storage.objects;

create policy media_select_workspace on storage.objects
for select to authenticated
using (
  bucket_id='media'
  and exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id::text=(storage.foldername(name))[1]
      and wm.user_id=(select auth.uid())
  )
);

create policy media_insert_workspace on storage.objects
for insert to authenticated
with check (
  bucket_id='media'
  and exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id::text=(storage.foldername(name))[1]
      and wm.user_id=(select auth.uid())
      and wm.role in ('owner','admin','editor','publisher')
  )
);

create policy media_update_workspace on storage.objects
for update to authenticated
using (
  bucket_id='media'
  and exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id::text=(storage.foldername(name))[1]
      and wm.user_id=(select auth.uid())
      and wm.role in ('owner','admin','editor','publisher')
  )
)
with check (
  bucket_id='media'
  and exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id::text=(storage.foldername(name))[1]
      and wm.user_id=(select auth.uid())
      and wm.role in ('owner','admin','editor','publisher')
  )
);

create policy media_delete_workspace on storage.objects
for delete to authenticated
using (
  bucket_id='media'
  and exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id::text=(storage.foldername(name))[1]
      and wm.user_id=(select auth.uid())
      and wm.role in ('owner','admin')
  )
);

-- Keep extensions out of public where practical.
-- pg_net was recreated in the extensions schema in production.
