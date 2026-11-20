-- backend/server.js looked up a user by email 10 times via
-- supabaseAdmin.auth.admin.listUsers() + a JS .find() scan — O(n) per request,
-- and silently stops finding anyone past the first page once the account base
-- grows beyond perPage (one call site even defaulted to perPage: 50). This
-- indexed SECURITY DEFINER lookup replaces that pattern everywhere it mattered.
create or replace function public.find_auth_user_by_email(p_email text)
returns table (id uuid, email text, email_confirmed_at timestamptz, deleted_at timestamptz, user_metadata jsonb)
language sql
security definer
set search_path = public, auth
stable
as $$
  select u.id, u.email, u.email_confirmed_at, u.deleted_at, u.raw_user_meta_data
    from auth.users u
   where u.email = lower(btrim(p_email))
   limit 1;
$$;

revoke all on function public.find_auth_user_by_email(text) from public, anon, authenticated;
grant execute on function public.find_auth_user_by_email(text) to service_role;
