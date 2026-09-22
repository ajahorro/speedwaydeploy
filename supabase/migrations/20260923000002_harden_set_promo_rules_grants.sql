-- Least-privilege hardening for public.set_promo_rules.
--
-- Postgres grants EXECUTE on new functions to PUBLIC by default, so the 20260923
-- migration (which only added `grant execute ... to authenticated`) left `anon`
-- holding an inherited EXECUTE privilege. The function is SECURITY DEFINER and
-- validates the caller's ADMIN role before writing, so this was not exploitable
-- — but an anonymous role has no business even reaching the body.
--
-- Revoke the implicit PUBLIC grant, then re-grant explicitly to authenticated.

revoke all on function public.set_promo_rules(jsonb) from public;
revoke all on function public.set_promo_rules(jsonb) from anon;
grant execute on function public.set_promo_rules(jsonb) to authenticated;
