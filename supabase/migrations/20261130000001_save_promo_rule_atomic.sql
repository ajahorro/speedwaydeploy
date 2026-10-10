-- Saving or archiving a promotion used to read the whole promo list, change it in the server and write it back,
-- so two admins (or two quick saves) could overwrite each other and a promo that was reported saved was lost.
-- This does the change inside the database under a row lock, so every save is kept.
create or replace function public.save_promo_rule(p_rule jsonb, p_must_exist boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
  v_rules jsonb;
  v_next jsonb;
  v_found boolean;
begin
  if jsonb_typeof(p_rule) <> 'object' or nullif(p_rule ->> 'id', '') is null then
    raise exception 'A promotion with an id is required.' using errcode = '22023';
  end if;

  select id, coalesce(promo_rules, '[]'::jsonb) into v_id, v_rules
    from public.business_config order by id limit 1 for update;
  if not found then
    insert into public.business_config (id, promo_rules, updated_at) values (1, jsonb_build_array(p_rule), now())
      returning promo_rules into v_next;
    return v_next;
  end if;
  if jsonb_typeof(v_rules) <> 'array' then v_rules := '[]'::jsonb; end if;

  v_found := exists (select 1 from jsonb_array_elements(v_rules) r where r ->> 'id' = p_rule ->> 'id');
  if p_must_exist and not v_found then
    raise exception 'Promo code not found.' using errcode = 'P0002';
  end if;

  if v_found then
    select jsonb_agg(case when r ->> 'id' = p_rule ->> 'id' then p_rule else r end order by ord)
      into v_next from jsonb_array_elements(v_rules) with ordinality as t(r, ord);
  else
    v_next := jsonb_build_array(p_rule) || v_rules;
  end if;

  update public.business_config set promo_rules = v_next, updated_at = now() where id = v_id;
  return v_next;
end;
$$;

revoke all on function public.save_promo_rule(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.save_promo_rule(jsonb, boolean) to service_role;
