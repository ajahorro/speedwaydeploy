-- System backups: a full copy of the shop's data, kept privately outside the live tables.
-- * export_system_backup()        -> every public table (minus one-time security rows) as {table: [rows]}
-- * restore_system_backup(tables) -> puts that data back in one transaction (all or nothing)
-- Both are server-only (service role). Files live in the private 'system-backups' bucket; this table lists them.

create table if not exists public.system_backups (
  id uuid primary key default gen_random_uuid(),
  file_path text not null unique,
  size_bytes bigint not null default 0,
  trigger text not null check (trigger in ('SCHEDULED', 'MANUAL', 'SAFETY')),
  table_count int not null default 0,
  row_count int not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '3 months'
);
alter table public.system_backups enable row level security; -- no policies: only the server reads it

insert into storage.buckets (id, name, public) values ('system-backups', 'system-backups', false)
on conflict (id) do nothing;

-- Tables never copied: one-time codes, links and lock counters (useless or unsafe to bring back), and this list.
create or replace function public.backup_excluded_tables() returns text[] language sql immutable as $$
  select array['system_backups', 'login_throttle', 'login_security_notices', 'password_confirmation_requests',
               'account_recovery_otps', 'qr_change_otp']
$$;

create or replace function public.export_system_backup()
returns jsonb language plpgsql security definer set search_path = public as $$
declare t text; rows jsonb; out jsonb := '{}';
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' and c.relname <> all (backup_excluded_tables())
            order by 1 loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]'') from public.%I x', t) into rows;
    out := out || jsonb_build_object(t, rows);
  end loop;
  return jsonb_build_object('format', 'comar-backup-v1', 'created_at', now(), 'tables', out);
end $$;

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
      -- accounts are never removed: update the ones that still exist, leave newer ones alone
      if cols is null then continue; end if;
      select string_agg(format('%1$s = excluded.%1$s', c), ', ') into upd
        from unnest(string_to_array(cols, ', ')) c where c <> 'id';
      execute format('insert into public.profiles (%1$s) select %1$s from jsonb_populate_recordset(null::public.profiles, $1)
                      where id in (select id from auth.users) on conflict (id) do update set %2$s', cols, upd) using rows;
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

revoke all on function public.export_system_backup() from public, anon, authenticated;
revoke all on function public.restore_system_backup(jsonb) from public, anon, authenticated;
grant execute on function public.export_system_backup() to service_role;
grant execute on function public.restore_system_backup(jsonb) to service_role;

-- Monthly: the server makes this month's backup if there isn't one yet and removes expired ones.
-- Calling it more than once does nothing extra, so it needs no secret.
select cron.schedule('monthly_system_backup', '7 0 1 * *', -- 00:07 UTC = 8:07 AM on the 1st, Manila time
  $cron$ select net.http_post(url := 'https://comargarage-backend.onrender.com/api/backups/scheduled',
                              headers := '{"Content-Type":"application/json"}'::jsonb,
                              body := '{}'::jsonb, timeout_milliseconds := 120000); $cron$);
