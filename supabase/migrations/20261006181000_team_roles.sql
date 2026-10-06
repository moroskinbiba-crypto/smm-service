alter table public.workspace_invites
  drop constraint if exists workspace_invites_role_check;

alter table public.workspace_invites
  add constraint workspace_invites_role_check
  check (role = any (array[
    'editor'::text,
    'publisher'::text,
    'approver'::text,
    'viewer'::text,
    'admin'::text
  ]));