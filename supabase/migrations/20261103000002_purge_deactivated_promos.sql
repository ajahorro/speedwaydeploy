-- Promo deletion is now a real delete (master plan 4.5). Earlier deletes only tombstoned the
-- rule (deleted_at set) and left it in the list; remove those leftovers once. Bookings keep
-- their own promo snapshot, so history is unaffected.
update public.business_config
   set promo_rules = coalesce((
     select jsonb_agg(rule)
       from jsonb_array_elements(coalesce(promo_rules, '[]'::jsonb)) as rule
      where rule ->> 'deleted_at' is null
   ), '[]'::jsonb)
 where jsonb_typeof(promo_rules) = 'array'
   and exists (
     select 1 from jsonb_array_elements(promo_rules) as r where r ->> 'deleted_at' is not null
   );
