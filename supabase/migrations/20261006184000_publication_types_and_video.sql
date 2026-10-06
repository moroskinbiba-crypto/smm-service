alter table public.post_targets
  add column if not exists publication_type text not null default 'feed';

alter table public.post_targets
  drop constraint if exists post_targets_publication_type_check;

alter table public.post_targets
  add constraint post_targets_publication_type_check
  check (publication_type = any (array['feed'::text,'reel'::text,'story'::text]));

create index if not exists post_targets_publication_type_idx
  on public.post_targets (platform, publication_type, status);