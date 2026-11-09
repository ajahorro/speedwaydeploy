-- "Book for customer": only the administrator who sent the invitation can see or open the booking details the
-- customer shares. Other administrators cannot read the invitation or its details.
drop policy if exists booking_draft_invites_select on public.booking_draft_invites;
create policy booking_draft_invites_select on public.booking_draft_invites
  for select to authenticated
  using (customer_id = (select auth.uid()) or (created_by = (select auth.uid()) and public.is_admin()));

create or replace function public.use_booking_draft_invite(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_invite public.booking_draft_invites%rowtype;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an administrator can open these details.' using errcode = '42501';
  end if;
  select * into v_invite from public.booking_draft_invites where id = p_invite_id for update;
  if not found then
    raise exception 'This invitation was not found.' using errcode = 'P0002';
  end if;
  if v_invite.created_by <> auth.uid() then
    raise exception 'Only the administrator who sent this invitation can open these details.' using errcode = '42501';
  end if;
  if v_invite.status <> 'SHARED' or v_invite.expires_at <= now() or v_invite.draft is null then
    raise exception 'The customer has not sent their details, or they have expired.' using errcode = '23514';
  end if;
  update public.booking_draft_invites set status = 'USED', used_at = now() where id = p_invite_id;
  return jsonb_build_object('customer_id', v_invite.customer_id, 'data', v_invite.draft, 'step', v_invite.draft_step);
end;
$fn$;
