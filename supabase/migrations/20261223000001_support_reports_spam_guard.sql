-- "Report an Issue" / data-deletion requests: keep every report in the database so the
-- anti-spam limits survive server restarts (the old limit lived in server memory) and so the
-- team still has the report when the email is held back. Only the backend (service role)
-- reads or writes this table; RLS is on with no policies, so the browser cannot touch it.
create table if not exists public.support_reports (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('ISSUE', 'DELETION_REQUEST')),
  message text not null check (char_length(message) between 1 and 4000),
  message_hash text not null,          -- normalised text fingerprint, for duplicate checks
  ip_hash text,                        -- salted hash of the sender's IP, never the IP itself
  page text,
  emailed boolean not null default false,
  held_reason text,                    -- why the email was not sent (daily cap, duplicate, provider error...)
  created_at timestamptz not null default now()
);

alter table public.support_reports enable row level security;

create index if not exists support_reports_profile_created_idx on public.support_reports (profile_id, created_at desc);
create index if not exists support_reports_ip_created_idx on public.support_reports (ip_hash, created_at desc);
create index if not exists support_reports_created_idx on public.support_reports (created_at desc);

-- Keep the table small: reports older than 180 days are removed every night (free tier friendly).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'purge_old_support_reports';
    perform cron.schedule('purge_old_support_reports', '17 3 * * *',
      $job$delete from public.support_reports where created_at < now() - interval '180 days'$job$);
  end if;
end $$;
