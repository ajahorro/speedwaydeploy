create table if not exists public.payment_refund_allocations (
  id uuid primary key default gen_random_uuid(),
  refund_payment_id uuid not null references public.payments(id) on delete cascade,
  source_payment_id uuid not null references public.payments(id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  constraint payment_refund_allocations_source_refund_unique
    unique (refund_payment_id, source_payment_id),
  constraint payment_refund_allocations_distinct_payments
    check (refund_payment_id <> source_payment_id)
);

create index if not exists payment_refund_allocations_source_idx
  on public.payment_refund_allocations(source_payment_id);

alter table public.payment_refund_allocations enable row level security;

drop policy if exists payment_refund_allocations_read_related on public.payment_refund_allocations;
create policy payment_refund_allocations_read_related
  on public.payment_refund_allocations
  for select
  to authenticated
  using (
    public.is_admin()
    or exists (
      select 1
        from public.payments source_payment
        join public.bookings booking on booking.id = source_payment.booking_id
       where source_payment.id = source_payment_id
         and booking.customer_id = auth.uid()
    )
  );

grant select on public.payment_refund_allocations to authenticated;

with source_rows as (
  select
    id,
    booking_id,
    created_at,
    amount::numeric as amount,
    coalesce(sum(amount::numeric) over (
      partition by booking_id
      order by created_at, id
      rows between unbounded preceding and 1 preceding
    ), 0) as amount_start,
    sum(amount::numeric) over (
      partition by booking_id
      order by created_at, id
      rows between unbounded preceding and current row
    ) as amount_end
  from public.payments
  where amount > 0
    and status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
    and method <> 'SYSTEM_REFUND'
),
refund_rows as (
  select
    id,
    booking_id,
    created_at,
    abs(amount::numeric) as amount,
    coalesce(sum(abs(amount::numeric)) over (
      partition by booking_id
      order by created_at, id
      rows between unbounded preceding and 1 preceding
    ), 0) as amount_start,
    sum(abs(amount::numeric)) over (
      partition by booking_id
      order by created_at, id
      rows between unbounded preceding and current row
    ) as amount_end
  from public.payments
  where amount < 0
    and method = 'SYSTEM_REFUND'
),
allocations as (
  select
    refund_rows.id as refund_payment_id,
    source_rows.id as source_payment_id,
    least(refund_rows.amount_end, source_rows.amount_end)
      - greatest(refund_rows.amount_start, source_rows.amount_start) as amount
  from refund_rows
  join source_rows on source_rows.booking_id = refund_rows.booking_id
    and source_rows.amount_end > refund_rows.amount_start
    and refund_rows.amount_end > source_rows.amount_start
)
insert into public.payment_refund_allocations (
  refund_payment_id,
  source_payment_id,
  amount
)
select refund_payment_id, source_payment_id, round(amount, 2)
from allocations
where amount > 0
on conflict (refund_payment_id, source_payment_id) do nothing;

do $$
begin
  if exists (
    select 1
      from public.payments refund_payment
      left join (
        select refund_payment_id, sum(amount) as allocated
          from public.payment_refund_allocations
         group by refund_payment_id
      ) allocation on allocation.refund_payment_id = refund_payment.id
     where refund_payment.method = 'SYSTEM_REFUND'
       and refund_payment.amount < 0
       and abs(refund_payment.amount) - coalesce(allocation.allocated, 0) > 0.01
  ) then
    raise exception 'Existing processed refund amounts could not be fully allocated to source payments';
  end if;
end;
$$;

create or replace function public.allocate_payment_refund()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_remaining numeric(12, 2) := round(abs(new.amount), 2);
  v_available numeric(12, 2);
  v_allocation numeric(12, 2);
  v_source record;
begin
  if new.method <> 'SYSTEM_REFUND' or new.amount >= 0 then
    return new;
  end if;

  for v_source in
    select source.id, source.amount::numeric as amount
      from public.payments source
     where source.booking_id = new.booking_id
       and source.amount > 0
       and source.status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
       and source.method <> 'SYSTEM_REFUND'
     order by source.created_at, source.id
     for update
  loop
    select greatest(0, v_source.amount - coalesce(sum(allocation.amount), 0))
      into v_available
      from public.payment_refund_allocations allocation
     where allocation.source_payment_id = v_source.id;

    v_allocation := least(v_remaining, v_available);
    if v_allocation > 0 then
      insert into public.payment_refund_allocations (
        refund_payment_id,
        source_payment_id,
        amount
      ) values (
        new.id,
        v_source.id,
        v_allocation
      );
      v_remaining := round(v_remaining - v_allocation, 2);
    end if;
    exit when v_remaining <= 0;
  end loop;

  if v_remaining > 0.01 then
    raise exception 'Refund % exceeds the remaining refundable source payments by %',
      new.id, v_remaining;
  end if;

  return new;
end;
$$;

drop trigger if exists payments_allocate_refund on public.payments;
create trigger payments_allocate_refund
  after insert on public.payments
  for each row
  when (new.method = 'SYSTEM_REFUND' and new.amount < 0)
  execute function public.allocate_payment_refund();
