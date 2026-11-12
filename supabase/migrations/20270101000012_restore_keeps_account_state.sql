-- Restore never revives a deactivated account or rolls an account's role back: for accounts that still exist,
-- role, is_active, deactivated_at, staff_deactivated_at and staff_deactivation_reason keep their current values.

create or replace function public.restore_system_backup(p_tables jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t text; rows jsonb; cols text; upd text; restored int := 0; seq record; mx bigint;
begin
  -- rules and links switch off only for this transaction, so rows can go back in any order
  set local session_replication_role = replica;

  for t in select key from jsonb_each(p_tables)
            where key <> all (backup_excluded_tables())
              and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                          where n.nspname = 'public' and c.relkind = 'r' and c.relname = key) loop
    rows := p_tables -> t;
    -- columns that exist now AND appear in the backup (newer columns keep their defaults)
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into cols
      from pg_attribute a
     where a.attrelid = format('public.%I', t)::regclass and a.attnum > 0 and not a.attisdropped
       and a.attgenerated = ''
       and exists (select 1 from jsonb_array_elements(rows) r where r ? a.attname);

    if t = 'profiles' then
      -- Accounts are never removed, and an account's standing is never rolled back: role, active/deactivated state
      -- and deactivation dates keep their CURRENT values (a restore must not revive a deactivated account or hand
      -- back a role that was taken away; sign-in blocks live outside the backup and would no longer match).
      -- Everything else about an existing account is put back; newer accounts are left alone.
      if cols is null then continue; end if;
      select string_agg(format('%1$s = excluded.%1$s', c), ', ') into upd
        from unnest(string_to_array(cols, ', ')) c
       where c <> all (array['id', 'role', 'is_active', 'deactivated_at', 'staff_deactivated_at', 'staff_deactivation_reason']);
      execute format('insert into public.profiles (%1$s) select %1$s from jsonb_populate_recordset(null::public.profiles, $1)
                      where id in (select id from auth.users) on conflict (id) do %2$s', cols,
                     case when upd is null then 'nothing' else 'update set ' || upd end) using rows;
    else
      execute format('delete from public.%I', t);
      if cols is not null then
        execute format('insert into public.%1$I (%2$s) overriding system value select %2$s from jsonb_populate_recordset(null::public.%1$I, $1)', t, cols)
          using rows;
      end if;
    end if;
    restored := restored + 1;
  end loop;

  -- counters continue after the restored rows
  for seq in select s.relname seqname, tc.relname tbl, a.attname col
               from pg_depend d join pg_class s on s.oid = d.objid and s.relkind = 'S'
               join pg_class tc on tc.oid = d.refobjid join pg_attribute a on a.attrelid = tc.oid and a.attnum = d.refobjsubid
               join pg_namespace n on n.oid = s.relnamespace where n.nspname = 'public' loop
    execute format('select max(%I) from public.%I', seq.col, seq.tbl) into mx;
    perform setval(format('public.%I', seq.seqname), coalesce(mx, 1), mx is not null);
  end loop;
  select max(receipt_no) into mx from public.payments;
  perform setval('public.payment_receipt_no_seq', coalesce(mx, 1), mx is not null);

  return jsonb_build_object('restored_tables', restored);
end $$;

revoke all on function public.restore_system_backup(jsonb) from public, anon, authenticated;
grant execute on function public.restore_system_backup(jsonb) to service_role;
alter function public.restore_system_backup(jsonb) set search_path = public;
