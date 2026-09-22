-- ============================================================================
-- Session 1 / Section 1.2: Emergency Account Recovery (email OTP)
-- ============================================================================
--
-- Backs the "Emergency Account Recovery" flow on the login screen. When a user
-- is locked out (DB lockout from 5 failed attempts) they can prove ownership of
-- the address with a 6-digit OTP. On success the backend:
--
--   1. clears the DB lock (failed_login_attempts = 0, locked_until = null)
--      via public.clear_login_lock(), and
--   2. issues a normal password-reset confirmation request so they can set a
--      fresh password on the /password-confirmation surface.
--
-- The OTP itself is never stored in plaintext: only a SHA-256 hash is persisted,
-- it is single-use (consumed_at), and it expires after 15 minutes. This mirrors
-- the password_confirmation_requests pattern so the recovery flow uses the same
-- hashing/expiry discipline rather than inventing a weaker one.
--
-- Guarded / idempotent: safe to re-run.
-- ============================================================================

create table if not exists public.account_recovery_otps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  otp_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

-- One active challenge per user: issuing a new OTP supersedes the old one.
create unique index if not exists account_recovery_otps_active_user_idx
  on public.account_recovery_otps (user_id)
  where consumed_at is null;

create index if not exists account_recovery_otps_lookup_idx
  on public.account_recovery_otps (otp_hash, expires_at)
  where consumed_at is null;

comment on table public.account_recovery_otps is
  'Section 1.2: single-use, hashed, 15-minute emergency-recovery OTPs. Only a SHA-256 hash is stored; the backend compares by hash and marks the row consumed on success.';

alter table public.account_recovery_otps enable row level security;

-- Server-only: the backend talks to this table with the service role. No client
-- (anon or authenticated) may read or write OTP rows directly.
revoke all on public.account_recovery_otps from anon, authenticated;
grant all on public.account_recovery_otps to service_role;
