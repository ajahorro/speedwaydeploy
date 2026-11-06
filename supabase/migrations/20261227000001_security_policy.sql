-- Privacy & security policy, next to the terms and conditions.
--
-- Same model as the role terms (20261103000001_role_terms.sql): one text and one version per role in
-- business_config, the accepted version on each profile, publishing and accepting only through functions, both
-- written to the audit log. Publishing a changed text bumps that role's version, so everyone in the role is asked
-- to read and agree again the next time they sign in (new accounts are asked on their first open).
-- accept_current_policies() records both documents at once, for the single pop-up that shows whatever changed.

alter table public.business_config
  add column if not exists security_policy_customer text,
  add column if not exists security_policy_staff text,
  add column if not exists security_policy_admin text,
  add column if not exists security_policy_customer_version integer not null default 1,
  add column if not exists security_policy_staff_version integer not null default 1,
  add column if not exists security_policy_admin_version integer not null default 1;

alter table public.profiles
  add column if not exists accepted_security_version integer,
  add column if not exists accepted_security_at timestamptz;

-- Starting texts in plain words, written for the Data Privacy Act of 2012 (RA 10173), its IRR and NPC issuances on
-- privacy notices, consent and breach notification. Administrators can rewrite them in Business Hub › Terms & Policies.
-- They are a starting point, not legal advice: the shop still has to designate a Data Protection Officer and check
-- whether it must register with the National Privacy Commission.
update public.business_config set security_policy_customer =
  '1. Who we are. Comar Garage ("we") runs this website and app and decides how the personal information in it is used. For any privacy question or request, contact our Data Protection Officer through the email address on our website or the chat in your account.' || chr(10) ||
  '2. What we collect. Your name, email address and mobile number; your vehicle details (type, brand, model and plate number); your bookings, chosen services, schedules and chat messages; the payment receipts you upload and our payment records; before-and-after photos of your vehicle taken by our technicians; and sign-in records (times, failed attempts, browser type) that keep your account safe.' || chr(10) ||
  '3. What we never ask for. Card numbers, PINs, one-time passwords (OTPs), online banking passwords or government ID numbers. Do not send these to us in any form.' || chr(10) ||
  '4. Why we use it. To take, schedule and carry out your booking and keep you updated (needed for the service you asked for); to check payments and keep business and tax records (required by law); to protect accounts and prevent fraud (our legitimate interest); and to send promotions only if you switch them on in Settings (your consent, which you can switch off at any time).' || chr(10) ||
  '5. Who handles it for us. Trusted service providers that must protect it: our database and server hosting (Supabase and Render, with servers in Singapore), website hosting (Vercel), email delivery (Resend), the map on our website (OpenStreetMap), website fonts (Google Fonts), and an AI service (Anthropic) that our staff may use to summarise booking reports, which can include customer names and vehicle details. Receipts are read on your own device. Some providers are outside the Philippines; we remain responsible for your information wherever it is processed. We do not sell your information.' || chr(10) ||
  '6. How long we keep it. Booking, payment and receipt records are kept for five years after the tax year they belong to, as tax rules require, then deleted or made anonymous. Vehicle photos are kept with their booking. Issue reports are deleted after 180 days. A deactivated account can be restored within 15 days; after that we keep only what the law requires.' || chr(10) ||
  '7. How we protect it. All connections are encrypted (HTTPS). Passwords are stored in a scrambled form that no one, including our staff, can read. Staff see only the information needed for their jobs, every action is recorded, accounts lock after repeated wrong passwords, and idle sessions sign out automatically.' || chr(10) ||
  '8. Your rights. Under the Data Privacy Act of 2012 (Republic Act No. 10173) you can ask what information we hold about you and get a copy, correct it (you can edit your profile yourself), object to its use, ask us to block or delete it, and receive it in a common file format. You may also claim damages for misuse and file a complaint with the National Privacy Commission (privacy.gov.ph). Send requests through Report an Issue or Account Data Deletion in Settings, or through the chat; we confirm it is really you before acting.' || chr(10) ||
  '9. If something goes wrong. If your information is exposed in a way likely to cause you serious harm, we will tell you and the National Privacy Commission within 72 hours of finding out, and explain what you can do to protect yourself.' || chr(10) ||
  '10. Changes to this policy. When we change it, you will be asked to read and agree to the new version the next time you sign in.'
 where nullif(btrim(coalesce(security_policy_customer, '')), '') is null;

update public.business_config set security_policy_staff =
  '1. Your own information. Comar Garage keeps your name, email address, mobile number, role, clock-in and clock-out times, the jobs assigned to you, the photos you upload and a record of what you do in the app. We use it to run the shop, pay and manage staff, and keep business records. You can ask to see or correct it, and file a complaint with the National Privacy Commission (privacy.gov.ph) under the Data Privacy Act of 2012.' || chr(10) ||
  '2. Your account is yours alone. Never share your password, never let someone else use your signed-in device, and sign out of shared devices when you finish.' || chr(10) ||
  '3. Customer information is confidential. Use names, phone numbers, vehicles, plate numbers and photos only for the job assigned to you. Never copy, screenshot, forward or post them outside the app, including on social media, even after you leave the shop.' || chr(10) ||
  '4. Photos. Take service photos only of the vehicle you are working on, only through the app, and keep people, faces and unrelated plate numbers out of the frame where you can.' || chr(10) ||
  '5. Never ask a customer for card numbers, PINs, one-time passwords (OTPs) or online banking passwords, and never handle payments outside the steps in the app.' || chr(10) ||
  '6. Report problems straight away. Tell an administrator at once if you lose a device, think someone used your account, or see customer information where it should not be. Quick reporting lets the shop meet its legal duty to notify within 72 hours.' || chr(10) ||
  '7. Every action in the app is recorded with your name and the time. Breaking these rules can lead to losing access and to action under shop rules and the law.'
 where nullif(btrim(coalesce(security_policy_staff, '')), '') is null;

update public.business_config set security_policy_admin =
  '1. Your own information. Comar Garage keeps your name, email address, mobile number, role and a record of what you do in the app, to run the shop and keep business records. You have the same rights over it as every user under the Data Privacy Act of 2012.' || chr(10) ||
  '2. Your account can see and change customer, staff and payment records. Never share your password, never leave a signed-in device unattended, and sign out of shared devices.' || chr(10) ||
  '3. Use personal information only for real shop work. Open customer, staff and payment details only when a task needs them, and never copy, export, screenshot or send them outside the app except for a legitimate business or legal need.' || chr(10) ||
  '4. Check before you act. Confirm who you are dealing with before changing an account, approving a payment, sending a refund or answering a request about someone''s data.' || chr(10) ||
  '5. Give access carefully. Invite staff and administrators only for people who work for the shop, give them only the access they need, and deactivate their accounts as soon as they leave.' || chr(10) ||
  '6. Respond to privacy requests. Pass every request to see, correct, block or delete personal data, and every deletion request from Settings, to the shop''s Data Protection Officer without delay.' || chr(10) ||
  '7. Breaches. If personal information may have been exposed (a lost device, a strange sign-in, data sent to the wrong person), tell the Data Protection Officer at once. Serious breaches must be reported to the National Privacy Commission and the affected people within 72 hours.' || chr(10) ||
  '8. Every action in the app is recorded with your name and the time.'
 where nullif(btrim(coalesce(security_policy_admin, '')), '') is null;

-- ── Only these functions (or the server) may set the accepted version ──────────────────────────────────────────
create or replace function public.guard_security_acceptance()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (new.accepted_security_version is distinct from old.accepted_security_version
      or new.accepted_security_at is distinct from old.accepted_security_at)
     and current_user not in ('service_role', 'postgres', 'supabase_admin')
     and not (coalesce(current_setting('app.allow_policy_accept', true), '') = 'true' and auth.uid() is not null and old.id = auth.uid()) then
    raise exception 'The security policy can only be accepted from its pop-up.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_security_acceptance on public.profiles;
create trigger trg_guard_security_acceptance
  before update of accepted_security_version, accepted_security_at on public.profiles
  for each row execute function public.guard_security_acceptance();

-- ── Accept whatever is current for my role: terms and security policy together ─────────────────────────────────
create or replace function public.accept_current_policies()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_profile record;
  v_key text;
  v_terms integer;
  v_security integer;
begin
  select id, role, full_name, email, accepted_terms_version, accepted_security_version
    into v_profile from public.profiles where id = auth.uid();
  if not found then
    raise exception 'Sign in to accept the terms.' using errcode = '42501';
  end if;
  v_key := public.terms_role_key(v_profile.role::text);
  execute format('select coalesce(terms_%1$s_version, 1), coalesce(security_policy_%1$s_version, 1) from public.business_config order by id limit 1', v_key)
    into v_terms, v_security;

  perform set_config('app.allow_terms_accept', 'true', true);
  perform set_config('app.allow_policy_accept', 'true', true);
  update public.profiles
     set accepted_terms_version = v_terms,
         accepted_terms_at = case when coalesce(accepted_terms_version, 0) < v_terms then now() else accepted_terms_at end,
         accepted_security_version = v_security,
         accepted_security_at = case when coalesce(accepted_security_version, 0) < v_security then now() else accepted_security_at end
   where id = v_profile.id;

  insert into public.audit_logs (action_type, details, actor_name, actor_role, actor_id, metadata)
  values ('TERMS_ACCEPTED',
          'Agreed to the ' || v_key || ' terms and conditions (version ' || v_terms || ') and privacy & security policy (version ' || v_security || ').',
          coalesce(v_profile.full_name, v_profile.email), v_profile.role::text, v_profile.id,
          jsonb_build_object('terms_role', v_key, 'terms_version', v_terms, 'security_version', v_security));

  return jsonb_build_object('terms_version', v_terms, 'security_version', v_security);
end;
$fn$;

-- ── Admin publishes a new privacy & security text for one role ─────────────────────────────────────────────────
create or replace function public.publish_security_policy(p_role text, p_text text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_key text := lower(btrim(coalesce(p_role, '')));
  v_old text;
  v_version integer;
  v_actor record;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can edit the security policy.' using errcode = '42501';
  end if;
  if v_key not in ('customer', 'staff', 'admin') then
    raise exception 'Unknown policy audience.';
  end if;
  if nullif(btrim(coalesce(p_text, '')), '') is null then
    raise exception 'The policy cannot be empty.';
  end if;
  if char_length(p_text) > 20000 then
    raise exception 'The policy is too long.';
  end if;

  execute format('select security_policy_%s from public.business_config order by id limit 1', v_key) into v_old;
  if btrim(coalesce(v_old, '')) = btrim(p_text) then
    raise exception 'Nothing changed. Edit the text before publishing.';
  end if;

  execute format(
    'update public.business_config set security_policy_%1$s = $1, security_policy_%1$s_version = coalesce(security_policy_%1$s_version, 1) + 1 where id = (select id from public.business_config order by id limit 1)',
    v_key) using btrim(p_text);
  execute format('select security_policy_%s_version from public.business_config order by id limit 1', v_key) into v_version;

  select full_name, email, role into v_actor from public.profiles where id = auth.uid();
  insert into public.audit_logs (action_type, details, actor_name, actor_role, actor_id, metadata)
  values ('TERMS_PUBLISHED', 'Published version ' || v_version || ' of the ' || v_key || ' privacy & security policy.',
          coalesce(v_actor.full_name, v_actor.email), v_actor.role::text, auth.uid(),
          jsonb_build_object('policy', 'security', 'terms_role', v_key, 'version', v_version));

  return jsonb_build_object('role', v_key, 'version', v_version);
end;
$fn$;

revoke all on function public.accept_current_policies() from public, anon;
revoke all on function public.publish_security_policy(text, text) from public, anon;
grant execute on function public.accept_current_policies() to authenticated;
grant execute on function public.publish_security_policy(text, text) to authenticated;
