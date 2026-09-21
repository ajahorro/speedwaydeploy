create table if not exists public.password_confirmation_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  purpose text not null check (purpose in ('RESET', 'UPDATE')),
  token_hash text not null unique,
  password_ciphertext text,
  password_iv text,
  password_tag text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists password_confirmation_requests_active_idx
  on public.password_confirmation_requests (token_hash, expires_at)
  where consumed_at is null;

alter table public.password_confirmation_requests enable row level security;

revoke all on public.password_confirmation_requests from anon, authenticated;
grant all on public.password_confirmation_requests to service_role;
