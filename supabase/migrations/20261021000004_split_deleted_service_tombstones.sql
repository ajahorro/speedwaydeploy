-- Keep deleted services separate from archived services.
-- The previous archived_service_ids column was used for both states, which made
-- deleted built-in rows reappear in the admin table as ARCHIVED rows.
alter table public.business_config
  add column if not exists deleted_service_ids jsonb default '[]'::jsonb;

comment on column public.business_config.deleted_service_ids is
  'Durable IDs for services deleted by an admin. Deleted rows stay hidden and are not restorable; archived_service_ids is reserved for restorable archived rows.';

update public.business_config
   set deleted_service_ids = '[]'::jsonb
 where deleted_service_ids is null;

-- The legacy column had no way to tell an archive from a delete. The current
-- production state was produced by the bulk-delete flow, so carry those old
-- suppression IDs into the permanent-deletion set and clear the misleading
-- restorable set. Future archive/delete actions are stored separately.
update public.business_config
   set deleted_service_ids = (
         select jsonb_agg(distinct value order by value)
           from jsonb_array_elements_text(
             coalesce(deleted_service_ids, '[]'::jsonb)
             || coalesce(archived_service_ids, '[]'::jsonb)
           ) as ids(value)
       ),
       archived_service_ids = '[]'::jsonb
 where jsonb_array_length(coalesce(archived_service_ids, '[]'::jsonb)) > 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'business_config_deleted_service_ids_is_array'
       and conrelid = 'public.business_config'::regclass
  ) then
    alter table public.business_config
      add constraint business_config_deleted_service_ids_is_array
      check (deleted_service_ids is null or jsonb_typeof(deleted_service_ids) = 'array');
  end if;
end $$;
