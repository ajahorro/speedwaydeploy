-- Treat blank payment references as absent while preserving uniqueness for
-- actual transaction references.
create or replace function public.normalize_empty_payment_reference()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.reference_number := nullif(btrim(new.reference_number), '');
  return new;
end;
$$;

drop trigger if exists trg_normalize_empty_payment_reference on public.payments;
create trigger trg_normalize_empty_payment_reference
  before insert or update on public.payments
  for each row
  execute function public.normalize_empty_payment_reference();