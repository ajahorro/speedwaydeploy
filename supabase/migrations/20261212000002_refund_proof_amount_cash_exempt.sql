-- 1. The amount read from a proof of refund is kept with it, so the booking can show what the proof said.
-- 2. A CASH refund needs no proof picture: the rule that a refund cannot be recorded without its proof now applies to
--    every refund method except cash (bank transfers still need the proof with its reference number).

alter table public.refund_proofs add column if not exists detected_amount numeric;

create or replace function public.require_refund_proof()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.method = 'SYSTEM_REFUND' and coalesce(new.amount, 0) < 0 and upper(btrim(coalesce(new.refund_method, ''))) <> 'CASH' then
    if not exists (
      select 1 from public.refund_proofs rp
       where rp.booking_id = new.booking_id and rp.refund_reference = new.reference_number
    ) then
      raise exception 'REFUND_PROOF_REQUIRED: upload the proof of refund before the refund is processed.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
