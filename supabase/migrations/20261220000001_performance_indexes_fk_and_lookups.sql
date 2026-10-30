-- ============================================================================
-- 20261220000001_performance_indexes_fk_and_lookups.sql
-- ============================================================================
-- Performance optimization migration:
-- Adds indexes on foreign keys, status fields, timestamp ranges, and email/user
-- lookup columns across high-traffic tables to accelerate read queries, joins,
-- customer login sessions, calendar renders, and administrative searches.
--
-- All index creations are guarded with `IF to_regclass(...) IS NOT NULL` and
-- `CREATE INDEX IF NOT EXISTS` so they can run safely and idempotently on any
-- deployment state without locking out active requests.
-- ============================================================================

-- ── 1. Authentication & User Profiles ─────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    -- Accelerate email lookups during sign-in, invitation checks, and registration duplicates
    CREATE INDEX IF NOT EXISTS profiles_email_lower_idx 
      ON public.profiles (lower(btrim(email)));

    -- Accelerate role-based access checks and active technician/admin lookups
    CREATE INDEX IF NOT EXISTS profiles_role_is_active_idx 
      ON public.profiles (role, is_active);

    -- Accelerate contact number lookups in customer directories and walk-in searches
    CREATE INDEX IF NOT EXISTS profiles_phone_number_idx 
      ON public.profiles (phone_number) 
      WHERE phone_number IS NOT NULL;

    -- Accelerate background sweep of deactivated accounts
    CREATE INDEX IF NOT EXISTS profiles_deactivated_sweep_idx 
      ON public.profiles (is_active, deactivated_at) 
      WHERE is_active = false;
  END IF;

  IF to_regclass('public.invites') IS NOT NULL THEN
    -- Accelerate invitation acceptance token validation
    CREATE INDEX IF NOT EXISTS invites_token_unused_idx 
      ON public.invites (token) 
      WHERE used = false;

    -- Accelerate invite duplicate checks by email
    CREATE INDEX IF NOT EXISTS invites_email_lower_idx 
      ON public.invites (lower(btrim(email)));
  END IF;
END $$;


-- ── 2. Bookings & Bay Scheduling (Core Operational Engine) ────────────────────
DO $$
BEGIN
  IF to_regclass('public.bookings') IS NOT NULL THEN
    -- FK to profiles: Critical for Customer "My Bookings" page and Admin User History
    CREATE INDEX IF NOT EXISTS bookings_customer_id_idx 
      ON public.bookings (customer_id);

    -- Composite index for customer portal sorting by latest appointment first
    CREATE INDEX IF NOT EXISTS bookings_customer_history_idx 
      ON public.bookings (customer_id, start_datetime DESC);

    -- FK to profiles: Critical for staff technician schedules & assignment lookups
    CREATE INDEX IF NOT EXISTS bookings_staff_id_idx 
      ON public.bookings (staff_id) 
      WHERE staff_id IS NOT NULL;

    -- Status filter index: Accelerates dashboard status badges, calendar queries & reports
    CREATE INDEX IF NOT EXISTS bookings_status_idx 
      ON public.bookings (status);

    -- Status + Start datetime: Used by schedule capacity checks, calendar bounds & no-show sweeps
    CREATE INDEX IF NOT EXISTS bookings_status_start_datetime_idx 
      ON public.bookings (status, start_datetime);

    -- Guest & walk-in customer email lookup
    CREATE INDEX IF NOT EXISTS bookings_customer_email_lower_idx 
      ON public.bookings (lower(btrim(customer_email))) 
      WHERE customer_email IS NOT NULL;

    -- Created_at index for admin chronological orderings
    CREATE INDEX IF NOT EXISTS bookings_created_at_idx 
      ON public.bookings (created_at DESC);
  END IF;

  IF to_regclass('public.booking_vehicles') IS NOT NULL THEN
    -- FK to bookings: Accelerates nested vehicle joins when loading booking details
    CREATE INDEX IF NOT EXISTS booking_vehicles_booking_id_idx 
      ON public.booking_vehicles (booking_id);

    -- FK to staff profile: Used in technician reports and per-vehicle duty tracking
    CREATE INDEX IF NOT EXISTS booking_vehicles_staff_id_idx 
      ON public.booking_vehicles (staff_id) 
      WHERE staff_id IS NOT NULL;

    -- Status index: Used for ongoing service checks (e.g. IN_PROGRESS, ONGOING)
    CREATE INDEX IF NOT EXISTS booking_vehicles_status_idx 
      ON public.booking_vehicles (status);

    -- Composite join index: booking_id + status
    CREATE INDEX IF NOT EXISTS booking_vehicles_booking_status_idx 
      ON public.booking_vehicles (booking_id, status);
  END IF;

  IF to_regclass('public.booking_vehicle_services') IS NOT NULL THEN
    -- FK to booking_vehicles: Essential join index for service items on each vehicle
    CREATE INDEX IF NOT EXISTS booking_vehicle_services_bvid_idx 
      ON public.booking_vehicle_services (booking_vehicle_id);

    -- Service ID lookup
    CREATE INDEX IF NOT EXISTS booking_vehicle_services_service_id_idx 
      ON public.booking_vehicle_services (service_id);
  END IF;
END $$;


-- ── 3. Payments, Ledger & Credit ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.payments') IS NOT NULL THEN
    -- FK to bookings: Accelerates balance computations & payment history modal loads
    CREATE INDEX IF NOT EXISTS payments_booking_id_idx 
      ON public.payments (booking_id);

    -- Status filter: Accelerates verification hubs (e.g. status = 'PENDING')
    CREATE INDEX IF NOT EXISTS payments_status_idx 
      ON public.payments (status);

    -- Composite index for booking financial rollup queries
    CREATE INDEX IF NOT EXISTS payments_booking_status_idx 
      ON public.payments (booking_id, status);

    -- Reference number lookup: Speeds up OCR receipt matching and duplicate fraud checks
    CREATE INDEX IF NOT EXISTS payments_reference_number_idx 
      ON public.payments (upper(btrim(reference_number))) 
      WHERE reference_number IS NOT NULL;

    -- Payment method filter
    CREATE INDEX IF NOT EXISTS payments_method_idx 
      ON public.payments (method);
  END IF;

  IF to_regclass('public.customer_credit_ledger') IS NOT NULL THEN
    -- FK to bookings: Speeds up booking-linked credit transactions
    CREATE INDEX IF NOT EXISTS customer_credit_ledger_booking_idx 
      ON public.customer_credit_ledger (booking_id) 
      WHERE booking_id IS NOT NULL;

    -- Customer ID lookup (if not already created)
    CREATE INDEX IF NOT EXISTS customer_credit_ledger_customer_idx 
      ON public.customer_credit_ledger (customer_id) 
      WHERE customer_id IS NOT NULL;
  END IF;
END $$;


-- ── 4. Customer Vehicles & Booking Drafts ──────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.vehicles') IS NOT NULL THEN
    -- FK to profiles: Loads customer's saved garage in Step 2 of booking wizard
    CREATE INDEX IF NOT EXISTS vehicles_owner_id_idx 
      ON public.vehicles (owner_id);

    -- Plate number lookup: Quick vehicle match by license plate
    CREATE INDEX IF NOT EXISTS vehicles_plate_number_idx 
      ON public.vehicles (upper(btrim(plate_number))) 
      WHERE plate_number IS NOT NULL;
  END IF;

  IF to_regclass('public.booking_drafts') IS NOT NULL THEN
    -- FK to auth.users: Resumes in-progress booking drafts immediately on wizard mount
    CREATE INDEX IF NOT EXISTS booking_drafts_user_id_idx 
      ON public.booking_drafts (user_id);
  END IF;
END $$;


-- ── 5. Auditing, Shifts, Messages & Catalog Lookups ────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    -- Accelerates filtering audit trails by specific action types (e.g. LOGIN, IDLE_SIGNOUT)
    CREATE INDEX IF NOT EXISTS audit_logs_action_type_idx 
      ON public.audit_logs (action_type, created_at DESC);

    -- Actor ID lookup for staff/admin audit history
    CREATE INDEX IF NOT EXISTS audit_logs_actor_id_idx 
      ON public.audit_logs (actor_id) 
      WHERE actor_id IS NOT NULL;
  END IF;

  IF to_regclass('public.audit_trails') IS NOT NULL THEN
    -- FK to booking: Link booking side records
    CREATE INDEX IF NOT EXISTS audit_trails_booking_id_idx 
      ON public.audit_trails (booking_id);

    -- Actor ID lookup
    CREATE INDEX IF NOT EXISTS audit_trails_actor_id_idx 
      ON public.audit_trails (actor_id) 
      WHERE actor_id IS NOT NULL;
  END IF;

  IF to_regclass('public.booking_events') IS NOT NULL THEN
    -- FK to booking: Chronological event timeline
    CREATE INDEX IF NOT EXISTS booking_events_booking_id_idx 
      ON public.booking_events (booking_id, created_at DESC);

    -- Actor ID lookup
    CREATE INDEX IF NOT EXISTS booking_events_actor_id_idx 
      ON public.booking_events (actor_id) 
      WHERE actor_id IS NOT NULL;
  END IF;

  IF to_regclass('public.booking_messages') IS NOT NULL THEN
    -- Sender ID lookup
    CREATE INDEX IF NOT EXISTS booking_messages_sender_id_idx 
      ON public.booking_messages (sender_id);
  END IF;

  IF to_regclass('public.staff_shifts') IS NOT NULL THEN
    -- Staff ID lookup for shifts
    CREATE INDEX IF NOT EXISTS staff_shifts_staff_id_idx 
      ON public.staff_shifts (staff_id);
  END IF;

  IF to_regclass('public.services') IS NOT NULL THEN
    -- Active catalog filtering: Accelerates Step 3 service catalog display
    CREATE INDEX IF NOT EXISTS services_is_active_category_idx 
      ON public.services (is_active, category);
  END IF;
END $$;

