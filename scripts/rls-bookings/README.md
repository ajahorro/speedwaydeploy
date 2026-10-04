# bookings / booking_vehicles RLS test matrix (local only)

Checks the policies from
`supabase/migrations/20261024000001_lock_down_bookings_rls.sql` (`public.bookings`)
and `supabase/migrations/20261024000002_lock_down_booking_vehicles_rls.sql`
(`public.booking_vehicles`, `public.booking_vehicle_services`) for anon,
customer, staff, deactivated staff, admin, deactivated admin and service role.
**Run it only against a throwaway local stack, never production.** The seed
files insert users and bookings.

```bash
# 1. Scratch stack on spare ports (54321-54327 and 55421/55432 are taken by other local stacks)
mkdir /tmp/rlstest && cd /tmp/rlstest && supabase init
#    edit supabase/config.toml: project_id, and 543xx -> 566xx ports
supabase start -x studio,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor,storage-api

# 2. Production schema (schema only, read-only dump) + fixtures
supabase db dump --linked -s public -f public_schema.sql   # run from the repo root
DB=supabase_db_<project_id>
docker exec -i $DB psql -U postgres -d postgres < public_schema.sql
docker exec -i $DB psql -U postgres -d postgres < scripts/rls-bookings/01_seed.sql
docker exec -i $DB psql -U postgres -d postgres < scripts/rls-bookings/02_harness.sql

# 3. Apply both migrations
docker exec -i $DB psql -U postgres -d postgres < supabase/migrations/20261024000001_lock_down_bookings_rls.sql
docker exec -i $DB psql -U postgres -d postgres < supabase/migrations/20261024000002_lock_down_booking_vehicles_rls.sql
#    Test setup only: put booking_vehicles in the local realtime publication for 07.
docker exec $DB psql -U postgres -c "alter publication supabase_realtime add table public.booking_vehicles" -c "notify pgrst, 'reload schema'"

# 4. bookings checks (SQL, then PostgREST with the frontend's real select strings).
#    Run these BEFORE 05_vehicles_seed.sql: their counts assume the 01_seed bookings only.
docker exec -i $DB psql -U postgres -d postgres -q < scripts/rls-bookings/03_matrix.sql | grep -E '^(PASS|FAIL)'
node scripts/rls-bookings/04_postgrest.cjs   # expects the stack on 127.0.0.1:56621

# 5. booking_vehicles / booking_vehicle_services checks
docker exec -i $DB psql -U postgres -d postgres < scripts/rls-bookings/05_vehicles_seed.sql
docker exec -i $DB psql -U postgres -d postgres -q < scripts/rls-bookings/06_vehicles_matrix.sql | grep -E '^(PASS|FAIL)'
node scripts/rls-bookings/07_vehicles_postgrest.cjs   # PostgREST + Realtime
```

Every line should be PASS. The node scripts load supabase-js from
`backend/node_modules`. In a git worktree without it, set
`SUPABASE_JS=<main checkout>/backend/node_modules/@supabase/supabase-js`.

To see the pre-migration exposure, run `03_matrix.sql` before applying
20261024000001 (anon can SELECT/UPDATE/DELETE/INSERT every booking), or run
`05_vehicles_seed.sql` + `06_vehicles_matrix.sql` before applying 20261024000002
(anon can read, rewrite and delete every vehicle and service line).
